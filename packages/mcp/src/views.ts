import { AdapterError, isRecord } from './client.js';

export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new AdapterError('INVALID_API_RESPONSE', 'The ContractGuard service returned an unexpected response shape.');
  return value;
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]));
}

export function page(items: unknown[], offset: number, limit: number): Record<string, unknown> {
  const selected = items.slice(offset, offset + limit);
  return { items: selected, total: items.length, offset, limit, nextOffset: offset + selected.length < items.length ? offset + selected.length : null };
}

export function listPage(value: unknown, field: string, offset: number, limit: number): Record<string, unknown> {
  const items = record(value)[field];
  if (!Array.isArray(items)) throw new AdapterError('INVALID_API_RESPONSE', 'The ContractGuard service returned an unexpected history response.');
  return page(items, offset, limit);
}

function consumerChecks(analysis: Record<string, unknown>): unknown[] {
  if (!isRecord(analysis.consumerImpact)) return [];
  return array(analysis.consumerImpact.consumers).flatMap((consumer) => !isRecord(consumer) ? [] : array(consumer.checks).map((check) => ({
    consumerId: consumer.id, consumerName: consumer.name, criticality: consumer.criticality,
    ...(consumer.owner === undefined ? {} : { owner: consumer.owner }),
    ...(isRecord(check) ? check : { check }),
  })));
}

export function analysisOverview(value: unknown): Record<string, unknown> {
  const analysis = record(value);
  const coverage = isRecord(analysis.coverage) ? analysis.coverage : undefined;
  const impact = isRecord(analysis.consumerImpact) ? analysis.consumerImpact : undefined;
  return {
    ...pick(analysis, ['id', 'createdAt', 'baselineName', 'candidateName', 'engineVersion', 'generatedAt', 'policy', 'source', 'score', 'compatible', 'summary']),
    coverage: coverage ? { status: coverage.status, warningsCount: array(coverage.warnings).length, truncated: coverage.truncated } : null,
    consumerImpact: impact ? { ...pick(impact, ['schemaVersion', 'evidenceKind', 'fingerprint', 'summary', 'gate', 'limitations']), unmappedChangeCount: array(impact.unmappedChangeIds).length } : null,
    sections: {
      changes: array(analysis.changes).length,
      consumerChecks: consumerChecks(analysis).length,
      coverageWarnings: array(coverage?.warnings).length,
      migrationTasks: array(impact?.migrationTasks).length,
    },
    interpretation: 'compatible/score reflect native static rules only; evaluate consumerImpact.gate and coverage separately.',
  };
}

export function analysisSection(value: unknown, section: string, offset: number, limit: number): Record<string, unknown> {
  if (section === 'overview') return analysisOverview(value);
  const analysis = record(value);
  let items: unknown[];
  switch (section) {
    case 'changes': items = array(analysis.changes); break;
    case 'consumerChecks': items = consumerChecks(analysis); break;
    case 'coverageWarnings': items = isRecord(analysis.coverage) ? array(analysis.coverage.warnings) : []; break;
    case 'migrationTasks': items = isRecord(analysis.consumerImpact) ? array(analysis.consumerImpact.migrationTasks) : []; break;
    default: throw new AdapterError('INVALID_SECTION', 'Unknown analysis section.');
  }
  return { analysisId: analysis.id, section, ...page(items, offset, limit) };
}

export function reviewOverview(value: unknown): Record<string, unknown> {
  const run = record(value);
  const upstream = isRecord(run.upstream) ? run.upstream : {};
  return {
    ...pick(run, ['schemaVersion', 'id', 'mode', 'status', 'createdAt', 'updatedAt', 'startedAt', 'finishedAt', 'baselineName', 'candidateName', 'goal', 'providerId', 'engineVersion', 'upstreamVersion', 'inputFingerprints', 'verdict', 'summary', 'recommendations', 'limitations', 'error', 'plannerCalls', 'nativeUnavailable', 'requiredTools', 'project']),
    callerReview: isRecord(run.callerReview) ? pick(run.callerReview, ['id', 'createdAt', 'evidenceKind', 'inputFingerprint', 'sourceFiles', 'summary', 'gate', 'limitations']) : null,
    projectTests: isRecord(run.projectTests) ? { ...pick(run.projectTests, ['schemaVersion', 'evidenceKind', 'projectId', 'snapshotFingerprint', 'runner', 'testFiles', 'status', 'patchStatus', 'patchIds', 'limitations']), phases: projectPhases(run.projectTests).map((phase) => pick(phase, ['id', 'phase', 'status', 'exitCode', 'tests', 'durationMs', 'truncated'])) } : null,
    upstream: pick(upstream, ['baselineValid', 'candidateValid', 'validationErrors', 'breakingCount', 'warningCount', 'truncated']),
    coreAnalysis: isRecord(run.coreAnalysis) ? analysisOverview(run.coreAnalysis) : null,
    sections: {
      steps: array(run.steps).length, findings: array(upstream.findings).length,
      nativeChanges: isRecord(run.coreAnalysis) ? array(run.coreAnalysis.changes).length : 0,
      consumerChecks: isRecord(run.coreAnalysis) ? consumerChecks(run.coreAnalysis).length : 0,
      recommendations: array(run.recommendations).length, limitations: array(run.limitations).length,
      callerChecks: isRecord(run.callerReview) ? array(run.callerReview.checks).length : 0,
      callerPatches: isRecord(run.callerReview) ? array(run.callerReview.patches).length : 0,
      projectTests: isRecord(run.projectTests) ? projectPhases(run.projectTests).length : 0,
    },
    interpretation: 'verdict is deterministic and never overridden by model prose. Poll get_review until terminal status.',
  };
}

export function reviewSection(value: unknown, section: string, offset: number, limit: number): Record<string, unknown> {
  if (section === 'overview') return reviewOverview(value);
  const run = record(value);
  let items: unknown[];
  switch (section) {
    case 'steps': case 'recommendations': case 'limitations': items = array(run[section]); break;
    case 'findings': items = isRecord(run.upstream) ? array(run.upstream.findings) : []; break;
    case 'nativeChanges': items = isRecord(run.coreAnalysis) ? array(run.coreAnalysis.changes) : []; break;
    case 'consumerChecks': items = isRecord(run.coreAnalysis) ? consumerChecks(run.coreAnalysis) : []; break;
    case 'callerChecks': items = isRecord(run.callerReview) ? array(run.callerReview.checks) : []; break;
    case 'callerPatches': items = isRecord(run.callerReview) ? array(run.callerReview.patches) : []; break;
    case 'projectTests': items = isRecord(run.projectTests) ? projectPhases(run.projectTests) : []; break;
    default: throw new AdapterError('INVALID_SECTION', 'Unknown review section.');
  }
  return { runId: run.id, section, ...page(items, offset, limit) };
}

function projectPhases(tests: Record<string, unknown>): Record<string, unknown>[] {
  return ['baseline', 'candidate', 'patched'].flatMap((phase) => isRecord(tests[phase]) ? [{ id: `PROJECT-${phase.toUpperCase()}`, phase, ...tests[phase] }] : []);
}

export function reportChunk(value: unknown, format: string, offset: number, maxCharacters: number): Record<string, unknown> {
  if (typeof value !== 'string') throw new AdapterError('INVALID_API_RESPONSE', 'Expected a text report from ContractGuard.');
  if (offset > value.length) throw new AdapterError('INVALID_REPORT_OFFSET', 'Report offset is beyond the end. Start at zero and follow nextOffset.');
  // Offsets are UTF-16 indices, but a chunk must not split a surrogate pair.
  if (offset > 0 && isLowSurrogate(value.charCodeAt(offset)) && isHighSurrogate(value.charCodeAt(offset - 1))) {
    throw new AdapterError('INVALID_REPORT_OFFSET', 'Report offset splits a Unicode character. Follow nextOffset from the previous chunk.');
  }
  let end = Math.min(value.length, offset + maxCharacters);
  if (end < value.length && isLowSurrogate(value.charCodeAt(end)) && isHighSurrogate(value.charCodeAt(end - 1))) end--;
  return { format, content: value.slice(offset, end), offset, totalCharacters: value.length, nextOffset: end < value.length ? end : null };
}

export function callerReviewOverview(value: unknown): Record<string, unknown> {
  const saved = record(value);
  const report = record(saved.report);
  return {
    ...pick(saved, ['id', 'createdAt']),
    ...pick(report, ['schemaVersion', 'toolVersion', 'generatedAt', 'evidenceKind', 'inputFingerprint', 'sourceFiles', 'summary', 'gate']),
    contractAnalysis: isRecord(report.contractAnalysis) ? analysisOverview(report.contractAnalysis) : null,
    sections: { callsites: array(report.callsites).length, checks: array(report.checks).length, patches: array(report.patches).length, limitations: array(report.limitations).length },
    interpretation: 'Bounded TypeScript AST replay against supplied fixtures (not full Node execution); verified patches do not clear the static gate.',
  };
}

export function callerReviewSection(value: unknown, section: string, offset: number, limit: number): Record<string, unknown> {
  if (section === 'overview') return callerReviewOverview(value);
  const saved = record(value); const report = record(saved.report);
  if (!['callsites', 'checks', 'patches', 'limitations'].includes(section)) throw new AdapterError('INVALID_SECTION', 'Unknown caller review section.');
  return { callerReviewId: saved.id, section, ...page(array(report[section]), offset, limit) };
}

function cegarWitnessItems(witnesses: Record<string, unknown> | undefined): unknown[] {
  if (!witnesses) return [];
  return array(witnesses.suites).flatMap((suite) => {
    if (!isRecord(suite)) return [];
    return array(suite.adversarial).map((item) => ({
      operation: suite.operation,
      ...(isRecord(item) ? item : { item }),
    }));
  });
}

export function cegarOverview(value: unknown): Record<string, unknown> {
  const run = record(value);
  const alignment = isRecord(run.alignment) ? run.alignment : undefined;
  const dataflow = isRecord(run.dataflow) ? run.dataflow : undefined;
  const witnesses = isRecord(run.witnesses) ? run.witnesses : undefined;
  const rounds = array(run.rounds);
  const patches = array(run.finalPatches);
  return {
    ...pick(run, [
      'schemaVersion', 'id', 'title', 'createdAt', 'mode', 'providerId', 'maxRounds',
      'enableAdversarialFuzzing', 'inputFingerprint', 'releaseGate', 'callerImpactStatus',
      'patchStatus', 'summary', 'llmCalls', 'durationMs',
    ]),
    metrics: dataflow && isRecord(dataflow.metrics) ? dataflow.metrics : null,
    witnesses: witnesses ? pick(witnesses, ['operations', 'adversarialCount']) : null,
    rounds: rounds.map((entry) => isRecord(entry) ? {
      ...pick(entry, ['round', 'proposer', 'actionSummary', 'citedHypothesisIds', 'citedCounterexampleIds', 'verification', 'durationMs']),
      counterexampleCount: array(entry.counterexamples).length,
    } : entry),
    patches: patches.map((patch) => isRecord(patch) ? pick(patch, ['file', 'sourceSha256', 'patchedSha256', 'rationale']) : patch),
    sections: {
      hypotheses: array(alignment?.hypotheses).length,
      witnesses: cegarWitnessItems(witnesses).length,
      rounds: rounds.length,
      patches: patches.length,
      reachability: array(dataflow?.reachability).length,
    },
    interpretation: '4-gate airgapped CEGAR verification (TypeChecker, nominal node --test, request contract, differential witnesses); verified caller patches do not clear server releaseGate.',
  };
}

export function cegarSection(value: unknown, section: string, offset: number, limit: number): Record<string, unknown> {
  if (section === 'overview') return cegarOverview(value);
  const run = record(value);
  const alignment = isRecord(run.alignment) ? run.alignment : undefined;
  const dataflow = isRecord(run.dataflow) ? run.dataflow : undefined;
  const witnesses = isRecord(run.witnesses) ? run.witnesses : undefined;
  let items: unknown[];
  switch (section) {
    case 'hypotheses': items = array(alignment?.hypotheses); break;
    case 'witnesses': items = cegarWitnessItems(witnesses); break;
    case 'rounds':
      items = array(run.rounds).map((entry) => isRecord(entry) ? {
        ...pick(entry, ['round', 'proposer', 'actionSummary', 'citedHypothesisIds', 'citedCounterexampleIds', 'verification', 'counterexamples', 'durationMs']),
        patchFiles: array(entry.patches).map((patch) => isRecord(patch) ? patch.file : patch),
      } : entry);
      break;
    case 'patches': items = array(run.finalPatches); break;
    case 'reachability': items = array(dataflow?.reachability); break;
    default: throw new AdapterError('INVALID_SECTION', 'Unknown CEGAR section.');
  }
  return { cegarRunId: run.id, section, ...page(items, offset, limit) };
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;
