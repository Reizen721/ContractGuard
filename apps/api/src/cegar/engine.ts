import { randomUUID } from 'node:crypto';
import {
  analyzeRelease,
  fingerprintObject,
  inferSchemaMigrations,
  synthesizeDifferentialWitnesses,
} from '@contractguard/core';
import { analyzeProgramDataflow, type CallerFile } from '@contractguard/caller';
import { verifyCegarWorkspace, type CegarSandboxInput } from '@contractguard/project';
import { getCegarLlmStatus, proposeLlmRoundPatches, type CegarLlmOptions } from './llm-proposer.js';
import { CEGAR_PRESETS } from './presets.js';
import { proposeSymbolicRoundPatches } from './synthesizer.js';
import type {
  CegarAgentMode,
  CegarFilePatch,
  CegarPreset,
  CegarRoundRecord,
  CegarRunRecord,
  CegarRunRequest,
} from './types.js';

export type * from './types.js';
export { CEGAR_PRESETS } from './presets.js';
export { getCegarLlmStatus, type CegarLlmOptions, type CegarLlmStatus } from './llm-proposer.js';

export interface RunCegarOptions extends CegarLlmOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

function filesEqual(a: CallerFile[], b: CallerFile[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((file, idx) => file.path === b[idx]?.path && file.content === b[idx]?.content);
}

export class CegarRequestError extends Error {
  readonly status = 400;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CegarRequestError';
  }
}

export function validateCegarRunRequest(raw: unknown): CegarRunRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CegarRequestError('INVALID_CEGAR_REQUEST', 'CEGAR request body must be a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  const modeRaw = obj.mode ?? 'symbolic';
  if (modeRaw !== 'symbolic' && modeRaw !== 'llm' && modeRaw !== 'hybrid') {
    throw new CegarRequestError('INVALID_CEGAR_MODE', 'mode must be symbolic, llm, or hybrid.');
  }
  const maxRoundsRaw = obj.maxRounds ?? 4;
  if (typeof maxRoundsRaw !== 'number' || !Number.isInteger(maxRoundsRaw) || maxRoundsRaw < 1 || maxRoundsRaw > 6) {
    throw new CegarRequestError('INVALID_CEGAR_ROUNDS', 'maxRounds must be an integer between 1 and 6.');
  }
  if (!Array.isArray(obj.callerFiles) || obj.callerFiles.length < 1 || obj.callerFiles.length > 25) {
    throw new CegarRequestError('INVALID_CALLER_FILES', 'callerFiles must contain 1 to 25 source files.');
  }
  if (!Array.isArray(obj.testFiles) || obj.testFiles.length < 1 || obj.testFiles.length > 15) {
    throw new CegarRequestError('INVALID_TEST_FILES', 'testFiles must contain 1 to 15 test files.');
  }
  for (const list of [obj.callerFiles, obj.testFiles]) {
    for (const item of list) {
      if (
        typeof item !== 'object' ||
        item === null ||
        typeof (item as CallerFile).path !== 'string' ||
        !(item as CallerFile).path.trim() ||
        typeof (item as CallerFile).content !== 'string'
      ) {
        throw new CegarRequestError('INVALID_FILE_ENTRY', 'Each caller/test file must include non-empty path and content.');
      }
    }
  }
  if (obj.baseline === undefined || obj.candidate === undefined) {
    throw new CegarRequestError('MISSING_CONTRACTS', 'Both baseline and candidate OpenAPI contracts are required.');
  }

  return {
    ...(typeof obj.title === 'string' && obj.title.trim() ? { title: obj.title.trim().slice(0, 200) } : {}),
    mode: modeRaw as CegarAgentMode,
    ...(typeof obj.providerId === 'string' && obj.providerId.trim() ? { providerId: obj.providerId.trim() } : {}),
    maxRounds: maxRoundsRaw,
    enableAdversarialFuzzing: obj.enableAdversarialFuzzing !== false,
    baseline: obj.baseline as CegarRunRequest['baseline'],
    candidate: obj.candidate as CegarRunRequest['candidate'],
    callerFiles: obj.callerFiles as CallerFile[],
    testFiles: obj.testFiles as CallerFile[],
    ...(Array.isArray(obj.probes) ? { probes: obj.probes as NonNullable<CegarRunRequest['probes']> } : {}),
    ...(typeof obj.seedBaselineResponses === 'object' && obj.seedBaselineResponses !== null
      ? { seedBaselineResponses: obj.seedBaselineResponses as NonNullable<CegarRunRequest['seedBaselineResponses']> }
      : {}),
  };
}

export function listCegarPresets(): CegarPreset[] {
  return CEGAR_PRESETS;
}

export async function runCegarMigration(
  rawRequest: CegarRunRequest,
  options: RunCegarOptions = {},
): Promise<CegarRunRecord> {
  const startedAt = Date.now();
  const request = validateCegarRunRequest(rawRequest);
  const mode = request.mode ?? 'symbolic';
  const maxRounds = request.maxRounds ?? 4;
  const enableAdversarialFuzzing = request.enableAdversarialFuzzing !== false;

  // Phase 0: Static release gate + Schema alignment hypotheses + TypeChecker program slicing + Witness synthesis
  const staticAnalysis = analyzeRelease(request.baseline, request.candidate);
  const releaseGate: CegarRunRecord['releaseGate'] =
    staticAnalysis.summary.breaking > 0
      ? 'blocked'
      : staticAnalysis.summary.potentiallyBreaking > 0
        ? 'review'
        : 'pass';

  const alignment = inferSchemaMigrations(request.baseline, request.candidate);
  const dataflow = analyzeProgramDataflow(request.callerFiles, request.baseline, request.candidate, alignment);
  const witnessSuites = synthesizeDifferentialWitnesses(request.baseline, request.candidate, {
    alignment,
    ...(request.seedBaselineResponses ? { seedBaselineResponses: request.seedBaselineResponses } : {}),
  });

  const sandboxInput: CegarSandboxInput = {
    baseline: request.baseline,
    candidate: request.candidate,
    callerFiles: request.callerFiles,
    testFiles: request.testFiles,
    ...(request.probes ? { probes: request.probes } : {}),
    ...(request.seedBaselineResponses ? { seedBaselineResponses: request.seedBaselineResponses } : {}),
    alignment,
    witnessSuites,
    enableAdversarialFuzzing,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  const unpatchedVerification = await verifyCegarWorkspace(sandboxInput);

  const witnessSummary: CegarRunRecord['witnesses'] = {
    operations: witnessSuites.length,
    adversarialCount: witnessSuites.reduce((sum, s) => sum + s.adversarial.length, 0),
    suites: witnessSuites.map((s) => ({
      operation: s.operation,
      baselineNominalId: s.baselineNominal.id,
      candidateNominalId: s.candidateNominal.id,
      adversarial: s.adversarial.map((w) => ({
        id: w.id,
        kind: w.kind,
        ...(w.targetPath ? { targetPath: w.targetPath } : {}),
        description: w.description,
      })),
    })),
  };

  const inputFingerprint = fingerprintObject({
    baseline: request.baseline,
    candidate: request.candidate,
    callerFiles: request.callerFiles,
    testFiles: request.testFiles,
    mode,
    maxRounds,
    enableAdversarialFuzzing,
  });

  // Early Exit: Unpatched caller already satisfies TypeChecker + Nominal + Request Contract + Adversarial Witnesses!
  if (unpatchedVerification.verified) {
    const hasStaticBreaking = staticAnalysis.summary.breaking > 0;
    const callerImpactStatus: CegarRunRecord['callerImpactStatus'] = hasStaticBreaking
      ? 'unreachable-breaking-safe'
      : 'compatible-verified';

    const summary = hasStaticBreaking
      ? `检出 ${staticAnalysis.summary.breaking} 项静态破坏性变更，但过程间可达性分析证明当前调用链未受影响，零补丁通过全部四道验证门。`
      : '候选契约向后兼容，未修改代码直接通过全部四道验证门。';

    return {
      schemaVersion: 1,
      id: randomUUID(),
      title: request.title ?? 'CEGAR 自修复迁移验证',
      createdAt: new Date().toISOString(),
      mode,
      ...(request.providerId ? { providerId: request.providerId } : {}),
      maxRounds,
      enableAdversarialFuzzing,
      inputFingerprint,
      releaseGate,
      callerImpactStatus,
      patchStatus: 'not-needed',
      alignment,
      dataflow: {
        callsites: dataflow.callsites,
        fieldUsages: dataflow.fieldUsages,
        callEdges: dataflow.callEdges,
        slices: dataflow.slices,
        metrics: dataflow.metrics,
        reachability: dataflow.reachability,
      },
      witnesses: witnessSummary,
      unpatchedVerification,
      rounds: [],
      finalPatches: [],
      llmCalls: 0,
      durationMs: Date.now() - startedAt,
      summary,
    };
  }

  // Phase 1..K: Multi-round Counterexample-Guided Abstraction Refinement (CEGAR) Loop
  const rounds: CegarRoundRecord[] = [];
  let currentFiles: CallerFile[] = request.callerFiles;
  let previousCounterexamples = unpatchedVerification.counterexamples;
  let verifiedFinalPatches: CegarFilePatch[] = [];
  let verified = false;
  let llmCalls = 0;
  const llmStatus = getCegarLlmStatus(options);

  for (let round = 1; round <= maxRounds; round++) {
    const roundStart = Date.now();
    let proposer: CegarRoundRecord['proposer'] = 'symbolic-ast';
    let proposal: {
      nextFiles: CallerFile[];
      patches: CegarFilePatch[];
      actionSummary: string;
      citedHypothesisIds: string[];
      citedCounterexampleIds: string[];
    };

    if (mode === 'llm') {
      proposer = 'llm-agent';
      llmCalls++;
      const currentDataflow = analyzeProgramDataflow(currentFiles, request.baseline, request.candidate, alignment);
      proposal = await proposeLlmRoundPatches({
        round,
        ...(request.providerId ? { providerId: request.providerId } : {}),
        currentFiles,
        originalFiles: request.callerFiles,
        alignment,
        dataflow: currentDataflow,
        previousCounterexamples,
        llmOptions: options,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } else {
      const symProposal = proposeSymbolicRoundPatches({
        round,
        currentFiles,
        originalFiles: request.callerFiles,
        baseline: request.baseline,
        candidate: request.candidate,
        alignment,
        previousCounterexamples,
      });

      if (mode === 'hybrid' && filesEqual(symProposal.nextFiles, currentFiles) && llmStatus.available) {
        proposer = 'llm-agent';
        llmCalls++;
        const currentDataflow = analyzeProgramDataflow(currentFiles, request.baseline, request.candidate, alignment);
        proposal = await proposeLlmRoundPatches({
          round,
          ...(request.providerId ? { providerId: request.providerId } : {}),
          currentFiles,
          originalFiles: request.callerFiles,
          alignment,
          dataflow: currentDataflow,
          previousCounterexamples,
          llmOptions: options,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } else {
        proposal = symProposal;
      }
    }

    const noStateChange = filesEqual(proposal.nextFiles, currentFiles);
    if (noStateChange && round > 1 && proposer === 'symbolic-ast') {
      break;
    }

    const roundVerif = await verifyCegarWorkspace(sandboxInput, proposal.nextFiles);
    const advPassed = roundVerif.adversarialResults.filter((r) => r.passed).length;
    const advTotal = roundVerif.adversarialResults.length;

    rounds.push({
      round,
      proposer,
      actionSummary: proposal.actionSummary,
      citedHypothesisIds: proposal.citedHypothesisIds,
      citedCounterexampleIds: proposal.citedCounterexampleIds,
      patches: proposal.patches,
      verification: {
        verified: roundVerif.verified,
        compilerClean: roundVerif.typecheck.clean,
        nominalPassed: Boolean(roundVerif.candidateRun?.passed) &&
          roundVerif.baselineRun?.testIdentityHash === roundVerif.candidateRun?.testIdentityHash,
        requestContractPassed: roundVerif.requestViolations.length === 0,
        adversarialPassed: advPassed,
        adversarialTotal: advTotal,
      },
      counterexamples: roundVerif.counterexamples,
      durationMs: Date.now() - roundStart,
    });

    currentFiles = proposal.nextFiles;
    previousCounterexamples = roundVerif.counterexamples;

    if (roundVerif.verified) {
      verified = true;
      verifiedFinalPatches = proposal.patches;
      break;
    }

    if (noStateChange && round > 1) {
      break;
    }
  }

  const callerImpactStatus: CegarRunRecord['callerImpactStatus'] = verified
    ? 'regression-repaired-verified'
    : 'regression-unresolved';
  const patchStatus: CegarRunRecord['patchStatus'] = verified ? 'verified' : 'failed';

  const summary = verified
    ? `经 ${rounds.length} 轮反例精化生成 ${verifiedFinalPatches.length} 个补丁，全部通过 TypeChecker、常规单测、出站契约及 ${rounds.at(-1)!.verification.adversarialPassed}/${rounds.at(-1)!.verification.adversarialTotal} 项对抗见证验证。`
    : `在 ${rounds.length} 轮预算内剩余 ${previousCounterexamples.length} 项反例未消除，按安全约束不输出未验证补丁。`;

  return {
    schemaVersion: 1,
    id: randomUUID(),
    title: request.title ?? 'CEGAR 自修复迁移验证',
    createdAt: new Date().toISOString(),
    mode,
    ...(request.providerId ? { providerId: request.providerId } : {}),
    maxRounds,
    enableAdversarialFuzzing,
    inputFingerprint,
    releaseGate,
    callerImpactStatus,
    patchStatus,
    alignment,
    dataflow: {
      callsites: dataflow.callsites,
      fieldUsages: dataflow.fieldUsages,
      callEdges: dataflow.callEdges,
      slices: dataflow.slices,
      metrics: dataflow.metrics,
      reachability: dataflow.reachability,
    },
    witnesses: witnessSummary,
    unpatchedVerification,
    rounds,
    finalPatches: verifiedFinalPatches,
    llmCalls,
    durationMs: Date.now() - startedAt,
    summary,
  };
}

export function formatCegarReportMarkdown(record: CegarRunRecord): string {
  const lines: string[] = [
    `# ContractGuard CEGAR Migration Report — ${record.title}`,
    '',
    `- **Run ID**: \`${record.id}\``,
    `- **Mode**: \`${record.mode}\` | **Created**: \`${record.createdAt}\` | **Duration**: \`${record.durationMs} ms\``,
    `- **Original Contract Release Gate**: \`${record.releaseGate}\` *(never cleared by caller patches)*`,
    `- **Caller Impact Diagnosis**: \`${record.callerImpactStatus}\``,
    `- **Verified Patch Status**: \`${record.patchStatus}\``,
    `- **Program Slice Compression**: \`${record.dataflow.metrics.slicedTokensApprox} / ${record.dataflow.metrics.fullTokensApprox} tokens (${Math.round((1 - record.dataflow.metrics.compressionRatio) * 100)}% reduction)\``,
    `- **Differential Witnesses**: \`${record.witnesses.adversarialCount}\` adversarial boundary payloads across \`${record.witnesses.operations}\` operations`,
    '',
    '## Executive Summary',
    '',
    record.summary,
    '',
    '## Inferred Schema Alignment Hypotheses',
    '',
  ];

  if (record.alignment.hypotheses.length === 0) {
    lines.push('_No structural/type migration hypotheses inferred._', '');
  } else {
    lines.push('| ID | Kind | Operation | Mapping | Confidence | Rationale |');
    lines.push('|---|---|---|---|---|---|');
    for (const h of record.alignment.hypotheses) {
      const mapping = `${h.fromPath ?? '(new)'} -> ${h.toPath ?? '(removed)'}`;
      lines.push(
        `| \`${h.id}\` | \`${h.kind}\` | \`${h.operation.method} ${h.operation.path}\` | \`${mapping}\` | ${(h.confidence * 100).toFixed(0)}% | ${h.rationale} |`,
      );
    }
    lines.push('');
  }

  lines.push('## CEGAR Refinement Trajectory', '');
  if (record.rounds.length === 0) {
    lines.push('_Zero refinement rounds needed (unpatched workspace passed all 4 verification gates)._', '');
  } else {
    for (const r of record.rounds) {
      lines.push(`### Round ${r.round} (${r.proposer}) — ${r.verification.verified ? 'VERIFIED' : 'COUNTEREXAMPLE CAUGHT'}`);
      lines.push(`- **Action**: ${r.actionSummary}`);
      lines.push(
        `- **4-Gate Verdict**: TypeChecker=\`${r.verification.compilerClean ? 'PASS' : 'FAIL'}\` | Nominal=\`${r.verification.nominalPassed ? 'PASS' : 'FAIL'}\` | OutboundRequest=\`${r.verification.requestContractPassed ? 'PASS' : 'FAIL'}\` | AdversarialWitnesses=\`${r.verification.adversarialPassed}/${r.verification.adversarialTotal}\``,
      );
      if (r.counterexamples.length > 0) {
        lines.push('- **Counterexamples Fed to Next Round**:');
        for (const cex of r.counterexamples) {
          lines.push(`  - \`${cex.id}\` [\`${cex.kind}\`${cex.witnessId ? ` / ${cex.witnessId}` : ''}]: ${cex.message}`);
        }
      }
      lines.push('');
    }
  }

  if (record.finalPatches.length > 0) {
    lines.push('## Verified Unified Diffs', '');
    for (const patch of record.finalPatches) {
      lines.push(`### \`${patch.file}\` (\`${patch.sourceSha256.slice(0, 12)} -> ${patch.patchedSha256.slice(0, 12)}\`)`);
      lines.push('```diff');
      lines.push(patch.unifiedDiff.trimEnd());
      lines.push('```', '');
    }
  }

  return lines.join('\n');
}
