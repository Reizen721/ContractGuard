import type { ConsumerImpactReport } from './evidence-types.js';

/** Plain text only; every renderer must escape these lines for its target format. */
export function consumerReportLines(report: ConsumerImpactReport | undefined): string[] {
  if (!report) return ['Consumer evidence: not supplied / not recorded. No claim about actual consumer impact.'];
  const summary = report.summary;
  return [
    `Consumer evidence gate: ${report.gate} (supplied examples only; independent of the static score).`,
    `Evidence SHA-256: ${report.fingerprint.value}`,
    `${summary.consumers} consumers; ${summary.checks} checks: ${summary.regressions} regressions, ${summary.passed} passed, ${summary.invalidBaselines} invalid baselines, ${summary.inconclusive} inconclusive.`,
    ...report.consumers.flatMap((consumer) => [
      `Consumer ${consumer.name} [${consumer.id}] · ${consumer.criticality} · Owner: ${consumer.owner ?? 'unassigned'}`,
      ...consumer.checks.flatMap((check) => [
        `  ${check.id} ${check.status}: ${check.kind} ${check.method} ${check.path} — ${check.name}`,
        `  Baseline: ${check.baseline.status}; candidate: ${check.candidate.status}. ${check.note}`,
        ...(['baseline', 'candidate'] as const).flatMap((side) => check[side].issues.map((issue) => `  ${side}: ${issue.code} at ${issue.path}: ${issue.message}`)),
        ...(check.baseline.truncated || check.candidate.truncated ? ['  Validation details truncated; inspect the bounds before relying on this result.'] : []),
        `  Related contract changes (operation context, not proven causation): ${check.relatedChangeIds.join(', ') || 'none'}`,
      ]),
    ]),
    `Risk findings without mapped consumer evidence: ${report.unmappedChangeIds.join(', ') || 'none'}`,
    ...report.migrationTasks.flatMap((task) => [
      `Task ${task.id} · ${task.priority} · ${task.consumerId} · Owner: ${task.owner ?? 'unassigned'}`,
      `  ${task.action}`,
      `  Verify: ${task.verification}`,
      `  Evidence: ${task.checkIds.join(', ')}; related changes: ${task.changeIds.join(', ') || 'none'}`,
    ]),
    ...report.limitations.map((line) => `Limit: ${line}`),
  ];
}
