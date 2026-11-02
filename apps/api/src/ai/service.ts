import { createHash } from 'node:crypto';
import { requestOpenAiChatCompletion, type OpenAiChatAdapterOptions } from './adapters/openai-chat.js';
import {
  createLegacyDeepSeekConfiguration,
  isLoopbackBaseUrl,
  legacyDeepSeekConfigFromEnvironment,
  loadAiConfiguration,
  type AiAdapterKind,
  type AiRuntimeConfig,
  type AiProfileConfig,
} from './config.js';
import { AI_PROMPT_VERSION, selectFindings } from './prompt.js';
import { parseAndValidateGeneratedReview } from './review-schema.js';
import { AiServiceError, type AiProviderStatus, type AiReviewRequest, type AiReviewService, type AiServiceStatus } from './types.js';

type Adapter = (options: OpenAiChatAdapterOptions) => ReturnType<typeof requestOpenAiChatCompletion>;

/** Only audited adapters compiled into the server may be selected by configuration. */
const ADAPTER_REGISTRY: Readonly<Record<AiAdapterKind, Adapter>> = Object.freeze({
  'openai-chat': requestOpenAiChatCompletion,
});

export interface MultiProviderAiServiceOptions {
  config?: AiRuntimeConfig;
  configPath?: string;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  /** Used only by the backwards-compatible programmatic DeepSeek configuration. */
  directSecrets?: Readonly<Record<string, string | undefined>>;
}

export function createMultiProviderAiService(options: MultiProviderAiServiceOptions = {}): AiReviewService {
  const environment = options.environment ?? process.env;
  const configPath = options.configPath ?? nonEmpty(environment.CONTRACTGUARD_LLM_CONFIG);
  const configured = options.config
    ?? (configPath === undefined ? undefined : loadAiConfiguration(configPath));
  const legacy = configured === undefined
    ? createLegacyDeepSeekConfiguration(legacyDeepSeekConfigFromEnvironment(environment))
    : undefined;
  const config = configured ?? legacy as AiRuntimeConfig;
  const directSecrets: Readonly<Record<string, string | undefined>> = options.directSecrets
    ?? (legacy === undefined ? {} : { deepseek: legacy.legacyApiKey });
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  function selectedProfile(request: AiReviewRequest): AiProfileConfig {
    if (!config.enabled) throw new AiServiceError(503, 'AI_DISABLED', 'AI review is disabled on this server.');
    const requestedId = request.providerId ?? config.activeProfile;
    if (request.providerId !== undefined && request.providerId !== config.activeProfile && !config.allowRequestProfileOverride) {
      throw new AiServiceError(400, 'AI_PROVIDER_OVERRIDE_DISABLED', 'Selecting a different AI provider is disabled on this server.');
    }
    const profile = config.profiles.find((candidate) => candidate.id === requestedId);
    if (!profile) throw new AiServiceError(400, 'AI_PROVIDER_NOT_FOUND', 'The requested AI provider is not configured on this server.');
    if (!profile.enabled) throw new AiServiceError(503, 'AI_PROVIDER_DISABLED', 'The requested AI provider is disabled on this server.');
    if (profile.auth.type === 'bearer' && resolveApiKey(profile.id, profile.auth, environment, directSecrets) === undefined) {
      throw new AiServiceError(503, 'AI_NOT_CONFIGURED', `AI review is enabled but ${profile.displayName} credentials are not configured.`);
    }
    return profile;
  }

  return {
    status(): AiServiceStatus {
      const providers = config.profiles.map((profile) => statusForProfile(config, profile.id, environment, directSecrets));
      const active = config.profiles.find((profile) => profile.id === config.activeProfile)!;
      const activeStatus = providers.find((profile) => profile.id === active.id)!;
      return {
        enabled: config.enabled,
        configured: activeStatus.configured,
        available: activeStatus.available,
        provider: active.provider,
        model: active.model,
        promptVersion: AI_PROMPT_VERSION,
        activeProfile: active.id,
        activeProviderId: active.id,
        defaultProviderId: active.id,
        allowRequestProfileOverride: config.allowRequestProfileOverride,
        allowRequestProviderOverride: config.allowRequestProfileOverride,
        providers,
      };
    },

    cacheIdentity(request) {
      const profile = selectedProfile(request);
      // Runtime configuration can contain a legacyApiKey; never hash or persist it.
      return createHash('sha256').update(JSON.stringify({ profile, limits: config.defaults, promptVersion: AI_PROMPT_VERSION })).digest('hex');
    },

    async review(analysis, request, callOptions) {
      const profile = selectedProfile(request);
      const apiKey = resolveApiKey(profile.id, profile.auth, environment, directSecrets);
      if (profile.auth.type === 'bearer' && apiKey === undefined) {
        throw new AiServiceError(503, 'AI_NOT_CONFIGURED', `AI review is enabled but ${profile.displayName} credentials are not configured.`);
      }

      const includedChangeIds = selectFindings(analysis.changes, config.defaults.maxChanges).map((change) => change.id);
      const adapter = ADAPTER_REGISTRY[profile.adapter];
      const completion = await adapter({
        profile,
        limits: config.defaults,
        analysis,
        request,
        ...(apiKey === undefined ? {} : { apiKey }),
        fetch: fetchImplementation,
        ...(callOptions?.signal === undefined ? {} : { signal: callOptions.signal }),
      });
      if (completion.finishReason === 'length') {
        throw new AiServiceError(
          502,
          'AI_INVALID_RESPONSE',
          `${profile.displayName} truncated the JSON review because the output token limit was reached. `
          + 'Increase defaults.maxOutputTokens or reduce defaults.maxChanges, then retry.',
        );
      }
      const generated = parseAndValidateGeneratedReview(
        completion.content,
        new Set(includedChangeIds),
        profile.displayName,
      );
      const coverage = {
        totalFindings: analysis.changes.length,
        includedFindings: includedChangeIds.length,
        omittedFindings: analysis.changes.length - includedChangeIds.length,
        includedChangeIds,
      };
      const serverCaveats: string[] = [];
      if (coverage.omittedFindings > 0) serverCaveats.push(request.language === 'zh-CN'
        ? `本次 AI 解读仅收到 ${coverage.includedFindings}/${coverage.totalFindings} 条变更，另有 ${coverage.omittedFindings} 条未提供给模型；请复核完整确定性报告。`
        : `The model received ${coverage.includedFindings}/${coverage.totalFindings} findings; ${coverage.omittedFindings} were omitted. Review the complete deterministic report.`);
      if (analysis.summary.breaking > 0 && generated.overview.riskLevel === 'low') serverCaveats.push(request.language === 'zh-CN'
        ? 'AI 的低风险评级仅代表解释层意见；确定性报告仍包含 breaking 变更，该评级不能覆盖确定性门禁。'
        : 'The AI low-risk opinion is an explanatory assessment; the deterministic report still contains breaking findings and its gate is unchanged.');
      if (analysis.consumerImpact && analysis.consumerImpact.gate !== 'pass') serverCaveats.push(request.language === 'zh-CN'
        ? `调用方样例门禁为 ${analysis.consumerImpact.gate}：${analysis.consumerImpact.summary.regressions} 项回归、${analysis.consumerImpact.summary.invalidBaselines + analysis.consumerImpact.summary.inconclusive} 项无效或不完整证据。AI 意见不能覆盖此门禁；这仍只是已提交样例的离线检查。`
        : `The consumer evidence gate is ${analysis.consumerImpact.gate}: ${analysis.consumerImpact.summary.regressions} regressions and ${analysis.consumerImpact.summary.invalidBaselines + analysis.consumerImpact.summary.inconclusive} invalid/inconclusive checks. AI opinions cannot override this gate; it only covers supplied offline examples.`);
      return {
        schemaVersion: '1.0',
        analysisId: analysis.id,
        provider: profile.provider,
        providerId: profile.id,
        providerLabel: profile.displayName,
        model: profile.model,
        generatedAt: now().toISOString(),
        promptVersion: AI_PROMPT_VERSION,
        ...generated,
        language: request.language,
        ...(request.focus === undefined ? {} : { focus: request.focus }),
        coverage,
        caveats: [...generated.caveats, ...serverCaveats],
        ...(completion.usage === undefined ? {} : { usage: completion.usage }),
      };
    },
  };
}

function statusForProfile(
  config: AiRuntimeConfig,
  profileId: string,
  environment: NodeJS.ProcessEnv,
  directSecrets: Readonly<Record<string, string | undefined>>,
): AiProviderStatus {
  const profile = config.profiles.find((candidate) => candidate.id === profileId)!;
  const configured = profile.auth.type === 'none'
    || resolveApiKey(profile.id, profile.auth, environment, directSecrets) !== undefined;
  return {
    id: profile.id,
    label: profile.displayName,
    displayName: profile.displayName,
    provider: profile.provider,
    model: profile.model,
    enabled: profile.enabled,
    configured,
    available: config.enabled && profile.enabled && configured,
    local: isLoopbackBaseUrl(profile.baseUrl),
  };
}

function resolveApiKey(
  profileId: string,
  auth: { type: 'bearer' | 'none'; secretEnv?: string },
  environment: NodeJS.ProcessEnv,
  directSecrets: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (auth.type === 'none') return undefined;
  return nonEmpty(directSecrets[profileId]) ?? nonEmpty(environment[auth.secretEnv as string]);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
