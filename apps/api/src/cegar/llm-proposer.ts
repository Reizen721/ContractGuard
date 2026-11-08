import {
  fingerprintText,
  type SchemaAlignmentReport,
} from '@contractguard/core';
import type { CallerFile, ProgramDataflowReport } from '@contractguard/caller';
import type { VerificationCounterexample } from '@contractguard/project';
import {
  createLegacyDeepSeekConfiguration,
  legacyDeepSeekConfigFromEnvironment,
  loadAiConfiguration,
  type AiProfileConfig,
  type AiRuntimeConfig,
} from '../ai/config.js';
import type { DeepSeekAiConfig } from '../ai/deepseek.js';
import { buildUnifiedDiff } from './synthesizer.js';
import type { CegarFilePatch } from './types.js';

export interface CegarLlmOptions {
  aiConfig?: Partial<DeepSeekAiConfig>;
  aiRuntimeConfig?: AiRuntimeConfig;
  aiConfigPath?: string;
  aiEnvironment?: NodeJS.ProcessEnv;
  aiFetch?: typeof globalThis.fetch;
}

export interface CegarLlmStatus {
  available: boolean;
  activeProfile: string;
  allowProfileOverride: boolean;
  providers: Array<{ id: string; label: string; available: boolean; model: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveRuntime(options: CegarLlmOptions) {
  const environment = options.aiEnvironment ?? process.env;
  const configPath = options.aiConfigPath ?? environment.CONTRACTGUARD_LLM_CONFIG;
  const configured = options.aiRuntimeConfig ?? (configPath ? loadAiConfiguration(configPath) : undefined);
  const legacyConfig = { ...legacyDeepSeekConfigFromEnvironment(environment), ...options.aiConfig };
  const config = configured ?? createLegacyDeepSeekConfiguration(legacyConfig);
  const fetcher = options.aiFetch ?? globalThis.fetch;
  const secret = (profile: AiProfileConfig): string | undefined =>
    !configured && profile.id === 'deepseek'
      ? legacyConfig.apiKey
      : profile.auth.secretEnv
        ? environment[profile.auth.secretEnv]
        : undefined;
  const available = (profile: AiProfileConfig): boolean =>
    config.enabled && profile.enabled && (profile.auth.type === 'none' || Boolean(secret(profile)?.trim()));

  return { config, fetcher, secret, available };
}

export function getCegarLlmStatus(options: CegarLlmOptions = {}): CegarLlmStatus {
  const { config, available } = resolveRuntime(options);
  return {
    available: config.profiles.some(
      (profile) => available(profile) && (config.allowRequestProfileOverride || profile.id === config.activeProfile),
    ),
    activeProfile: config.activeProfile,
    allowProfileOverride: config.allowRequestProfileOverride,
    providers: config.profiles.map((profile) => ({
      id: profile.id,
      label: profile.displayName,
      available: available(profile),
      model: profile.model,
    })),
  };
}

const proposalJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['actionSummary', 'citedHypothesisIds', 'citedCounterexampleIds', 'edits'],
  properties: {
    actionSummary: { type: 'string' },
    citedHypothesisIds: { type: 'array', items: { type: 'string' } },
    citedCounterexampleIds: { type: 'array', items: { type: 'string' } },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'patchedContent', 'rationale'],
        properties: {
          file: { type: 'string' },
          patchedContent: { type: 'string' },
          rationale: { type: 'string' },
        },
      },
    },
  },
};

export async function proposeLlmRoundPatches(options: {
  round: number;
  providerId?: string;
  currentFiles: CallerFile[];
  originalFiles: CallerFile[];
  alignment: SchemaAlignmentReport;
  dataflow: ProgramDataflowReport;
  previousCounterexamples: VerificationCounterexample[];
  llmOptions?: CegarLlmOptions;
  signal?: AbortSignal;
}): Promise<{
  nextFiles: CallerFile[];
  patches: CegarFilePatch[];
  actionSummary: string;
  citedHypothesisIds: string[];
  citedCounterexampleIds: string[];
}> {
  const {
    round,
    providerId,
    currentFiles,
    originalFiles,
    alignment,
    dataflow,
    previousCounterexamples,
    llmOptions = {},
    signal,
  } = options;
  const { config, fetcher, secret, available } = resolveRuntime(llmOptions);

  if (providerId !== undefined && !config.allowRequestProfileOverride && providerId !== config.activeProfile) {
    throw Object.assign(new Error('Only the active server-configured model profile can be selected.'), {
      status: 400,
      code: 'CEGAR_PROFILE_OVERRIDE_DISABLED',
    });
  }
  const profile = config.profiles.find((p) => p.id === (providerId ?? config.activeProfile));
  if (!profile || !available(profile)) {
    throw Object.assign(
      new Error('The selected LLM profile is disabled or its API credential is not configured.'),
      { status: 503, code: 'CEGAR_LLM_UNAVAILABLE' },
    );
  }

  // Only expose impacted caller files (or files cited in counterexamples) + minimal AST program slices!
  const relevantFileSet = new Set<string>([
    ...dataflow.slices.map((s) => s.file),
    ...previousCounterexamples.map((c) => c.file).filter((f): f is string => Boolean(f)),
  ]);
  if (relevantFileSet.size === 0) {
    for (const f of currentFiles) relevantFileSet.add(f.path);
  }

  const promptPayload = {
    round,
    allowedCallerFiles: currentFiles.map((f) => f.path),
    schemaAlignmentHypotheses: alignment.hypotheses,
    programSlices: dataflow.slices,
    impactedFilesCurrentSource: currentFiles.filter((f) => relevantFileSet.has(f.path)),
    previousRoundCounterexamples: previousCounterexamples,
  };

  const body: Record<string, unknown> = {
    model: profile.model,
    stream: false,
    messages: [
      {
        role: 'system',
        content:
          'You are ContractGuard CEGAR (Counterexample-Guided Abstraction Refinement) API Migration Synthesizer. ' +
          'Given OpenAPI Schema Alignment Hypotheses, TypeScript AST Program Slices, impacted caller source files, ' +
          'and structured Counterexamples from the previous sandbox verification round (TypeScript TypeChecker diagnostics, ' +
          'nominal test failures, outbound HTTP request contract violations, or adversarial witness crash stack traces), ' +
          'return a single JSON object matching the schema: { actionSummary, citedHypothesisIds, citedCounterexampleIds, edits: [{ file, patchedContent, rationale }] }. ' +
          'Rules: (1) Only modify files listed in allowedCallerFiles. (2) Return the COMPLETE valid TypeScript source in patchedContent for each modified file. ' +
          '(3) Preserve all exports and unrelated logic. (4) Handle nullable/optional/extended-enum counterexamples defensively without breaking nominal semantics. No markdown fences.',
      },
      {
        role: 'user',
        content: JSON.stringify(promptPayload),
      },
    ],
  };

  if (profile.capabilities.thinkingControl === 'disabled') body.thinking = { type: 'disabled' };
  const tokenParam = profile.capabilities.tokenLimitParameter ?? 'max_tokens';
  if (tokenParam !== 'none') body[tokenParam] = Math.min(config.defaults.maxOutputTokens, 8192);
  if (profile.capabilities.structuredOutput === 'json-object') body.response_format = { type: 'json_object' };
  if (profile.capabilities.structuredOutput === 'json-schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'contractguard_cegar_patch', strict: true, schema: proposalJsonSchema },
    };
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), Math.min(config.defaults.timeoutMs, 60_000));

  try {
    const endpoint = `${profile.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const response = await fetcher(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(profile.auth.type === 'bearer' ? { Authorization: `Bearer ${secret(profile)}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error(`LLM endpoint returned HTTP ${response.status}.`), {
        status: 502,
        code: 'CEGAR_LLM_HTTP_ERROR',
      });
    }

    const text = await response.text();
    const envelope = JSON.parse(text) as unknown;
    if (!isRecord(envelope) || !Array.isArray(envelope.choices) || !isRecord(envelope.choices[0])) {
      throw new Error('Invalid chat completion envelope.');
    }
    const msg = envelope.choices[0].message;
    if (!isRecord(msg) || typeof msg.content !== 'string') {
      throw new Error('Empty chat completion content.');
    }

    const cleanedJson = msg.content
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    const parsed = JSON.parse(cleanedJson) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.edits)) {
      throw new Error('LLM output did not match CegarProposal schema.');
    }

    const allowedPaths = new Set(currentFiles.map((f) => f.path));
    const knownHypIds = new Set(alignment.hypotheses.map((h) => h.id));
    const knownCexIds = new Set(previousCounterexamples.map((c) => c.id));

    const editMap = new Map<string, { patchedContent: string; rationale: string }>();
    for (const rawEdit of parsed.edits) {
      if (
        isRecord(rawEdit) &&
        typeof rawEdit.file === 'string' &&
        allowedPaths.has(rawEdit.file) &&
        typeof rawEdit.patchedContent === 'string' &&
        rawEdit.patchedContent.trim().length > 0
      ) {
        editMap.set(rawEdit.file, {
          patchedContent: rawEdit.patchedContent,
          rationale: typeof rawEdit.rationale === 'string' ? rawEdit.rationale.slice(0, 400) : 'LLM CEGAR patch',
        });
      }
    }

    const nextFiles: CallerFile[] = currentFiles.map((cur) => {
      const edit = editMap.get(cur.path);
      return edit ? { path: cur.path, content: edit.patchedContent } : cur;
    });

    const patches: CegarFilePatch[] = [];
    for (const nf of nextFiles) {
      const orig = originalFiles.find((o) => o.path === nf.path) ?? nf;
      if (nf.content !== orig.content) {
        const edit = editMap.get(nf.path);
        patches.push({
          file: nf.path,
          sourceSha256: fingerprintText(orig.content).value,
          patchedSha256: fingerprintText(nf.content).value,
          unifiedDiff: buildUnifiedDiff(nf.path, orig.content, nf.content),
          patchedContent: nf.content,
          rationale: edit?.rationale ?? 'Retained edit from previous CEGAR round.',
        });
      }
    }

    const citedHypothesisIds = Array.isArray(parsed.citedHypothesisIds)
      ? parsed.citedHypothesisIds.filter((id): id is string => typeof id === 'string' && knownHypIds.has(id))
      : [];
    const citedCounterexampleIds = Array.isArray(parsed.citedCounterexampleIds)
      ? parsed.citedCounterexampleIds.filter((id): id is string => typeof id === 'string' && knownCexIds.has(id))
      : [];

    return {
      nextFiles,
      patches,
      actionSummary:
        typeof parsed.actionSummary === 'string' && parsed.actionSummary.trim()
          ? parsed.actionSummary.trim().slice(0, 400)
          : `LLM 第 ${round} 轮生成 ${editMap.size} 个文件迁移补丁。`,
      citedHypothesisIds,
      citedCounterexampleIds,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
