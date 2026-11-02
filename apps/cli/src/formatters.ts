import type { AnalysisResult, Change } from '@contractguard/core';
import { consumerReportLines } from '@contractguard/core';

export type OutputFormat = 'table' | 'json' | 'markdown' | 'html';

export function formatResult(result: AnalysisResult, format: OutputFormat, labels: { baseline: string; candidate: string }): string {
  if (format === 'json') return `${JSON.stringify(result, null, 2)}\n`;
  if (format === 'markdown') return markdown(result, labels);
  if (format === 'html') return htmlReport(result, labels);
  return table(result, labels);
}

function table(result: AnalysisResult, labels: { baseline: string; candidate: string }): string {
  const lines = [
    `ContractGuard: ${terminalSafe(labels.baseline)} -> ${terminalSafe(labels.candidate)}`,
    `Score ${result.score}/100 | ${result.compatible ? 'NO COVERED BREAKING CHANGES' : 'BREAKING CHANGES'} | breaking ${result.summary.breaking} | potential ${result.summary.potentiallyBreaking} | safe ${result.summary.nonBreaking} | info ${result.summary.info}`,
    ...coverageText(result).map(terminalSafe),
    ...sourceAudit(result).map(terminalSafe),
    ...consumerReportLines(result.consumerImpact).map(terminalSafe),
    '',
  ];
  if (result.changes.length === 0) return `${lines.join('\n')}No contract changes detected.\n`;

  const rows = result.changes.map((change) => [label(change.severity), change.ruleId, change.location, change.message]);
  const headers = ['SEVERITY', 'RULE', 'LOCATION', 'MESSAGE'];
  const widths = headers.map((header, column) => Math.min(42, Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length))));
  lines.push(row(headers, widths), widths.map((width) => '-'.repeat(width)).join('-+-'));
  for (const [index, value] of rows.entries()) {
    lines.push(row(value, widths));
    for (const [side, source] of Object.entries(result.changes[index]?.sourceLocations ?? {})) {
      if (source) lines.push(`  ${side} source: ${terminalSafe(source.file)}${source.pointer.startsWith('#') ? '' : '#'}${terminalSafe(source.pointer)}`);
    }
  }
  lines.push('', 'Exit policy is controlled by --fail-on (exit code 2 means incompatibility threshold reached).');
  return `${lines.join('\n')}\n`;
}

function row(values: string[], widths: number[]): string {
  return values.map((value, index) => truncate(terminalSafe(value), widths[index] ?? 20).padEnd(widths[index] ?? 20)).join(' | ');
}

export function terminalSafe(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => /[\t\n\r]/.test(character) ? ' ' : `\\x${character.codePointAt(0)?.toString(16).padStart(2, '0')}`)
    .replace(/\s+/g, ' ');
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}

function label(severity: Change['severity']): string {
  return ({ breaking: 'BREAKING', 'potentially-breaking': 'POTENTIAL', 'non-breaking': 'SAFE', info: 'INFO' } as const)[severity];
}

function markdown(result: AnalysisResult, labels: { baseline: string; candidate: string }): string {
  const lines = [
    '# ContractGuard compatibility report', '',
    `- Baseline: **${md(labels.baseline)}**`,
    `- Candidate: **${md(labels.candidate)}**`,
    `- Score: **${result.score}/100**`,
    `- Backward compatible: **${result.compatible ? 'Yes' : 'No'}**`,
    `- Generated: ${result.generatedAt}`,
    `- Engine: \`${result.engineVersion}\``,
    ...(result.policy ? [`- Policy: \`${result.policy.id}\` · SHA-256 \`${result.policy.fingerprint.value}\``] : []),
    ...(result.source.old.fingerprint ? [`- Baseline SHA-256: \`${result.source.old.fingerprint.value}\``] : []),
    ...(result.source.new.fingerprint ? [`- Candidate SHA-256: \`${result.source.new.fingerprint.value}\``] : []),
    ...sourceAudit(result).map((line) => `- ${md(line)}`),
    '', '## Analysis coverage', '', ...coverageText(result).map(md),
    '', '## Consumer evidence and migration tasks', '', ...consumerReportLines(result.consumerImpact).map(md),
    '',
    '| Breaking | Potential | Non-breaking | Info | Total |',
    '| ---: | ---: | ---: | ---: | ---: |',
    `| ${result.summary.breaking} | ${result.summary.potentiallyBreaking} | ${result.summary.nonBreaking} | ${result.summary.info} | ${result.summary.total} |`, '',
    '## Findings', '',
  ];
  if (result.changes.length === 0) lines.push('No contract changes detected.', '');
  for (const [index, change] of result.changes.entries()) {
    lines.push(
      `### ${index + 1}. [${change.severity}] ${md(change.message)}`, '',
      `- Rule: \`${change.ruleId}\``,
      `- Location: \`${String(change.location).replace(/`/g, '\\`')}\``,
      ...Object.entries(change.sourceLocations ?? {}).flatMap(([side, source]) => source ? [`- ${side} source: ${md(source.file)}${source.pointer.startsWith('#') ? '' : '#'}${md(source.pointer)}`] : []),
      ...(change.recommendation ? [`- Recommendation: ${md(change.recommendation)}`] : []),
      '',
    );
  }
  lines.push('> Static rule analysis is not a formal proof of runtime compatibility.', '');
  return lines.join('\n');
}

function htmlReport(result: AnalysisResult, labels: { baseline: string; candidate: string }): string {
  const rows = result.changes.map((change) => `<tr><td class="${css(change.severity)}">${esc(change.severity)}</td><td><code>${esc(change.ruleId)}</code></td><td><code>${esc(change.location)}</code>${Object.entries(change.sourceLocations ?? {}).map(([side, source]) => source ? `<div>${esc(side)}: <code>${esc(source.file)}${source.pointer.startsWith('#') ? '' : '#'}${esc(source.pointer)}</code></div>` : '').join('')}</td><td>${esc(change.message)}</td></tr>`).join('');
  const audit = [
    `Engine ${result.engineVersion}`,
    ...(result.policy ? [`Policy ${result.policy.id} · ${result.policy.fingerprint.value}`] : []),
    ...(result.source.old.fingerprint ? [`Baseline SHA-256 ${result.source.old.fingerprint.value}`] : []),
    ...(result.source.new.fingerprint ? [`Candidate SHA-256 ${result.source.new.fingerprint.value}`] : []),
    ...sourceAudit(result),
  ].map((item) => `<div><code>${esc(item)}</code></div>`).join('')
    + `<section><h2>Analysis coverage</h2>${coverageText(result).map((line) => `<p>${esc(line)}</p>`).join('')}</section>`
    + `<section><h2>Consumer evidence and migration tasks</h2>${consumerReportLines(result.consumerImpact).map((line) => `<p>${esc(line)}</p>`).join('')}</section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ContractGuard report</title><style>body{font:15px system-ui;margin:40px;color:#18202c;background:#f5f7fb}main{max-width:1100px;margin:auto}header,section{background:white;border:1px solid #dfe5ee;border-radius:14px;padding:24px;margin-bottom:18px}.score{font-size:44px;font-weight:800;color:${result.compatible ? '#087f5b' : '#c92a2a'}}.audit{color:#596579;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}th,td{padding:12px;border-bottom:1px solid #e9edf3;text-align:left;vertical-align:top}.breaking{color:#c92a2a}.potentially-breaking{color:#a65b00}.non-breaking{color:#087f5b}.info{color:#1554ad}code{font-size:12px}</style></head><body><main><header><h1>ContractGuard report</h1><p>${esc(labels.baseline)} → ${esc(labels.candidate)}</p><div class="score">${result.score}/100</div><p>${result.compatible ? 'No covered breaking changes detected' : 'Breaking changes detected'}</p><div class="audit">${audit}</div></header><section><table><thead><tr><th>Severity</th><th>Rule</th><th>Location</th><th>Finding</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No contract changes detected.</td></tr>'}</tbody></table></section><small>Static rule analysis is not a formal proof of runtime compatibility.</small></main></body></html>\n`;
}

function css(value: string): string {
  return value.replace(/[^a-z-]/g, '');
}

function coverageText(result: AnalysisResult): string[] {
  return result.coverage ? [
    `Coverage: ${result.coverage.status}. Complete means no known warnings in this implemented profile, not proof of runtime safety.`,
    ...result.coverage.warnings.map((warning) => `${warning.side} ${warning.code} at ${warning.source ? `${warning.source.file}${warning.source.pointer.startsWith('#') ? '' : '#'}${warning.source.pointer}` : warning.location}: ${warning.message}`),
    ...(result.coverage.truncated ? ['Warning list truncated.'] : []),
  ] : ['Coverage: not recorded by this older engine. Do not infer complete coverage.'];
}

function sourceAudit(result: AnalysisResult): string[] {
  return (['old', 'new'] as const).flatMap((side) => {
    const source = result.source[side];
    return [...(source.dialect ? [`${side} dialect: ${source.dialect}`] : []),
      ...(source.bundle ? [`${side} entry: ${source.bundle.entry}`, ...source.bundle.files.map((file) => `${side} dependency: ${file.path} · SHA-256 ${file.fingerprint.value}`)] : [])];
  });
}

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

function md(value: string): string {
  return value.replace(/([\\`*_{}\[\]<>#+.!|~-])/g, '\\$1');
}
