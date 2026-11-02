import type { AiReview } from './types.js';

export function renderAiReview(review: AiReview, format: 'json' | 'markdown'): string {
  if (format === 'json') return `${JSON.stringify(review, null, 2)}\n`;
  const lines = [
    '# ContractGuard AI explanation', '',
    `- Analysis: ${md(review.analysisId)}`,
    `- Review: ${md(review.id ?? '')}`,
    `- Provider/model: ${md(review.providerLabel)} / ${md(review.model)}`,
    `- Generated: ${md(review.generatedAt)}`,
    `- Prompt: ${md(review.promptVersion)}`,
    ...(review.coverage ? [`- Finding coverage: ${review.coverage.includedFindings}/${review.coverage.totalFindings}; omitted: ${review.coverage.omittedFindings}`] : []),
    '', '> AI explanations are untrusted advice. They do not replace deterministic findings or the release gate.', '',
    `## ${md(review.overview.headline)}`, '', md(review.overview.executiveSummary), '',
    `AI risk opinion: ${md(review.overview.riskLevel)}`, '', '## Key risks', '',
  ];
  for (const risk of review.keyRisks) lines.push(
    `### ${md(risk.changeId)} — ${md(risk.title)}`, '', md(risk.explanation), '',
    `- Priority: ${md(risk.priority)}`,
    `- Potential consumers (AI inference): ${risk.affectedConsumers.map(md).join('; ')}`,
    `- Remediation: ${md(risk.remediation)}`, '',
  );
  lines.push('## Migration plan', '');
  for (const step of review.migrationPlan) lines.push(`### ${step.order}. ${md(step.title)}`, '',
    ...step.actions.map((action) => `- ${md(action)}`), `- Evidence: ${step.relatedChangeIds.map(md).join(', ')}`, '');
  lines.push('## Test suggestions', '');
  for (const suggestion of review.testSuggestions) lines.push(`### ${md(suggestion.title)}`, '', md(suggestion.details), '',
    `- Evidence: ${suggestion.relatedChangeIds.map(md).join(', ')}`, '');
  lines.push('## Caveats', '', ...review.caveats.map((caveat) => `- ${md(caveat)}`), '');
  return lines.join('\n');
}

function md(value: string): string {
  // Escape HTML and Markdown control characters so generated text remains inert in renderers.
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, '\\$&').replace(/\r?\n/g, ' ');
}
