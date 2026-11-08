import { analyzeRelease, fingerprintObject, fingerprintText, prepareContract, resolveNode, validateEvidenceValue, type OpenApiDocument } from '@contractguard/core';
import ts from 'typescript';
import { parseCallerFile, type ParsedFile } from './source.js';
import { replay, type ReplayResult } from './replay.js';
import { record, validateCallerInput } from './validate.js';
import type { CallerCheck, CallerImpactInput, CallerImpactReport, CallerOperation, CallerPatch, CallerPatchEdit, CallerReplayOutcome, CallerResponse, CallerScenario } from './types.js';
export type * from './types.js';
export { validateCallerInput, validateCallerPath, CallerInputError, CALLER_LIMITS } from './validate.js';
export {
  analyzeProgramDataflow,
  createVirtualTsProgram,
  typecheckVirtualFiles,
  type CompilerDiagnostic,
  type CrossFileCallEdge,
  type FieldUsageKind,
  type ProgramDataflowReport,
  type ProgramSlice,
  type TrackedFieldUsage,
  type TrackedHttpCallsite,
  type TypecheckReport,
} from './program-slice.js';
export const CALLER_VERSION = '2.0.0';

function responseSchema(document: OpenApiDocument, operation: CallerOperation, status: number): unknown {
  const path = resolveNode(document, document.paths?.[operation.path]);
  if (!record(path)) return undefined;
  const method = resolveNode(document, path[operation.method.toLowerCase()]);
  if (!record(method) || !record(method.responses)) return undefined;
  const response = resolveNode(document, method.responses[String(status)] ?? method.responses[`${String(status)[0]}XX`] ?? method.responses.default);
  if (!record(response) || !record(response.content) || !record(response.content['application/json'])) return undefined;
  return response.content['application/json'].schema;
}
function sampleReplay(parsed: ParsedFile, scenario: CallerScenario, response: CallerResponse, document: OpenApiDocument): ReplayResult {
  const functionSites = parsed.sites.filter((site) => site.report.exportName === scenario.exportName);
  if (functionSites.length && functionSites.every((site) => site.report.status === 'resolved') && !functionSites.some((site) => site.report.method === scenario.operation.method && site.report.path === scenario.operation.path)) return unsupported('Scenario operation does not match the source request.');
  let schema: unknown;
  try { schema = responseSchema(document, scenario.operation, response.status); }
  catch { return unsupported('The response schema could not be resolved.'); }
  if (schema === undefined) return unsupported('The operation/status must declare an application/json response schema.');
  const validation = validateEvidenceValue(response.body, schema, { document, direction: 'response' });
  if (validation.status === 'unknown') return unsupported('Response sample validation is outside the supported schema profile.');
  if (validation.status === 'invalid') return { outcome: { status: 'failed', error: `Supplied response sample violates its declared contract: ${validation.issues[0]?.message ?? 'invalid body'}`, steps: 0, requests: 0 }, reads: [], siteIds: [] };
  return replay(parsed, scenario, response);
}
function unsupported(message: string): ReplayResult { return { outcome: { status: 'unsupported', error: message, steps: 0, requests: 0 }, reads: [], siteIds: [] }; }
function addReads(parsed: ParsedFile, result: ReplayResult): void {
  for (const read of result.reads) {
    const site = parsed.sites.find((entry) => entry.report.id === read.siteId); if (!site) continue;
    if (!site.report.fields.some((field) => field.start === read.start)) {
      const point = parsed.source.getLineAndCharacterOfPosition(read.start);
      site.report.fields.push({ path: read.path.join('.'), line: point.line + 1, column: point.character + 1, start: read.start, end: read.end });
    }
  }
}
function checkStatus(baseline: CallerReplayOutcome, candidate: CallerReplayOutcome): CallerCheck['status'] {
  if (baseline.status === 'failed') return 'invalid-baseline';
  if (baseline.status === 'unsupported' || candidate.status === 'unsupported') return 'inconclusive';
  // Invalid candidate samples are not an actual execution of the source function.
  if (candidate.requests === 0) return 'inconclusive';
  return candidate.status === 'failed' ? 'regression' : 'pass';
}
const checkNotes: Record<CallerCheck['status'], string> = {
  pass: 'The supplied baseline and candidate samples satisfy their schemas and the explicit output oracle under bounded AST replay.',
  regression: 'The baseline replay passes and the candidate replay fails the same explicit output oracle or raises a supported runtime error.',
  'invalid-baseline': 'The baseline sample/replay fails; this is not evidence of a newly introduced regression.',
  inconclusive: 'Unsupported source/schema, a mismatched operation, or invalid candidate evidence prevents a complete replay conclusion.',
};
function operationChangeIds(report: CallerImpactReport['contractAnalysis'], operation: CallerOperation): string[] {
  const pathPrefix = `paths[${JSON.stringify(operation.path)}]`;
  return report.changes.filter((change) => change.location === pathPrefix || change.location.startsWith(`${pathPrefix}.${operation.method.toLowerCase()}`)).map((change) => change.id);
}
function inlineProperty(document: OpenApiDocument, operation: CallerOperation, statuses: number[], key: string): boolean {
  return statuses.length > 0 && statuses.every((status) => {
    const schema = responseSchema(document, operation, status);
    return record(schema) && !schema.$ref && !schema.allOf && !schema.anyOf && !schema.oneOf && record(schema.properties) && Object.hasOwn(schema.properties, key);
  });
}
function unifiedDiff(path: string, before: string, after: string): string {
  const oldLines = before.replace(/\r\n/g, '\n').split('\n'); const newLines = after.replace(/\r\n/g, '\n').split('\n');
  // Emit a full-file hunk; this is a proposal, never an automatically applied patch.
  if (oldLines.at(-1) === '') oldLines.pop(); if (newLines.at(-1) === '') newLines.pop();
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${oldLines.length} +1,${newLines.length} @@`, ...oldLines.map((line) => `-${line}`), ...(!before.endsWith('\n') ? ['\\ No newline at end of file'] : []), ...newLines.map((line) => `+${line}`), ...(!after.endsWith('\n') ? ['\\ No newline at end of file'] : []), ''].join('\n');
}
function createPatches(input: CallerImpactInput, parsedFiles: ParsedFile[], checks: CallerCheck[], traces: Map<string, ReplayResult>, baselineDoc: OpenApiDocument, candidateDoc: OpenApiDocument, limitations: string[]): CallerPatch[] {
  const patches: CallerPatch[] = [];
  for (const parsed of parsedFiles) {
    const fileScenarios = input.scenarios.filter((scenario) => scenario.file === parsed.file.path);
    const edits = new Map<number, CallerPatchEdit>(); let conflict = false;
    for (const rename of input.fieldRenames ?? []) {
      const matchingScenarios = fileScenarios.filter((scenario) => scenario.operation.method === rename.method && scenario.operation.path === rename.path);
      if (!matchingScenarios.length) continue;
      if (!inlineProperty(baselineDoc, rename, matchingScenarios.map((s) => s.baselineResponse.status), rename.from) || !inlineProperty(candidateDoc, rename, matchingScenarios.map((s) => s.candidateResponse.status), rename.to)) {
        limitations.push(`Rename ${rename.method} ${rename.path}: ${rename.from} → ${rename.to} was not proposed: both fields must exist in the relevant inline response schemas.`); continue;
      }
      for (const scenario of matchingScenarios) {
        const check = checks.find((item) => item.scenarioId === scenario.id)!;
        if (check.baseline.status !== 'passed') continue;
        for (const read of traces.get(scenario.id)?.reads ?? []) {
          if (read.path.length !== 1 || read.path[0] !== rename.from) continue;
          // A dynamic index is a selection expression, not a proven field reference.
          if (ts.isElementAccessExpression(read.node) && (!read.node.argumentExpression || !(ts.isStringLiteral(read.node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(read.node.argumentExpression)))) continue;
          const site = parsed.sites.find((item) => item.report.id === read.siteId);
          if (!site || site.report.method !== rename.method || site.report.path !== rename.path || site.report.status !== 'resolved') continue;
          const after = ts.isPropertyAccessExpression(read.node) ? rename.to : JSON.stringify(rename.to);
          const edit = { start: read.start, end: read.end, before: read.before, after };
          const previous = edits.get(edit.start); if (previous && previous.after !== after) conflict = true;
          edits.set(edit.start, edit);
        }
      }
    }
    if (!edits.size || conflict) { if (conflict) limitations.push(`${parsed.file.path}: conflicting mappings prevented a patch proposal.`); continue; }
    const ordered = [...edits.values()].sort((a, b) => a.start - b.start);
    if (ordered.some((edit, i) => (i > 0 && ordered[i - 1]!.end > edit.start) || parsed.file.content.slice(edit.start, edit.end) !== edit.before)) { limitations.push(`${parsed.file.path}: edit provenance check failed.`); continue; }
    let patchedContent = parsed.file.content;
    for (const edit of [...ordered].reverse()) patchedContent = patchedContent.slice(0, edit.start) + edit.after + patchedContent.slice(edit.end);
    const patched = parseCallerFile({ path: parsed.file.path, content: patchedContent }, [baselineDoc, candidateDoc], 1);
    const results = fileScenarios.map((scenario) => ({ scenarioId: scenario.id, outcome: sampleReplay(patched, scenario, scenario.candidateResponse, candidateDoc).outcome }));
    const originalChecks = checks.filter((check) => check.file === parsed.file.path);
    const uncoveredSites = parsed.sites.some((site) => !originalChecks.some((check) => check.callsiteIds.includes(site.report.id)));
    const hasRegression = originalChecks.some((check) => check.status === 'regression');
    const allBaselineValid = originalChecks.every((check) => check.baseline.status === 'passed');
    const verified = !uncoveredSites && hasRegression && allBaselineValid && results.length > 0 && results.every((item) => item.outcome.status === 'passed');
    const status = verified ? 'verified' : results.some((item) => item.outcome.status === 'failed') ? 'failed' : 'unverified';
    patches.push({
      id: `PATCH-${String(patches.length + 1).padStart(4, '0')}`, file: parsed.file.path,
      sourceSha256: fingerprintText(parsed.file.content).value, patchedSha256: fingerprintText(patchedContent).value,
      edits: ordered, unifiedDiff: unifiedDiff(parsed.file.path, parsed.file.content, patchedContent), patchedContent,
      verification: { status, checkIds: originalChecks.map((check) => check.id), results, reason: verified ? 'All supplied scenarios for this file pass against candidate samples after the patch; the original regression is reproduced and every baseline passes. This is bounded sample verification, not the complete application test suite.' : 'The patch is not verified: require a reproduced regression, valid baselines, all known callsites covered, and every supplied file scenario passing after the change.' },
    });
  }
  return patches;
}

export function analyzeCallerImpact(rawInput: unknown): CallerImpactReport {
  const input = validateCallerInput(rawInput);
  // Persistable reports use JSON semantics; strip optional undefined values from the legacy core result.
  const contractAnalysis = JSON.parse(JSON.stringify(analyzeRelease(input.baseline, input.candidate))) as CallerImpactReport['contractAnalysis'];
  const baselineDoc = prepareContract(input.baseline).document; const candidateDoc = prepareContract(input.candidate).document;
  const limitations = [
    'Evidence is bounded TypeScript AST replay of explicitly supplied response samples, not Node.js execution, live HTTP traffic, or a complete application test suite.',
    'Only named async exported functions, one literal fetch/axios operation per scenario, const bindings, supported expressions, if/switch and JSON responses are interpreted. Imports, arbitrary globals, mutable state and unsupported syntax remain unknown.',
    'Request bodies, authentication, headers, serialization, retries, URL origins, real network behavior, module initialization and external dependencies are not verified. Only fetch method options and one-argument axios calls are supported.',
    'Field usages reflect executed sample paths. Unexecuted branches and files not submitted are outside this evidence; a passing finite sample set is not proof of production compatibility.',
    'Related change IDs are operation-level context, not a claim that each linked static change caused a caller failure.',
    'Renames are explicitly supplied semantic mappings. Patches modify in-memory source copies only, and verified means every supplied scenario for that file passes; static contract findings and the release gate are retained.',
  ];
  const parsedFiles: ParsedFile[] = []; let nextId = 1;
  for (const file of input.files) {
    const parsed = parseCallerFile(file, [baselineDoc, candidateDoc], nextId); nextId += parsed.sites.length; parsedFiles.push(parsed);
    if (parsed.problem) limitations.push(`${file.path}: ${parsed.problem}`);
    for (const site of parsed.sites) if (site.report.path && site.report.method) site.report.relatedChangeIds = operationChangeIds(contractAnalysis, { method: site.report.method, path: site.report.path });
  }
  const checks: CallerCheck[] = []; const traces = new Map<string, ReplayResult>();
  for (const scenario of input.scenarios) {
    const parsed = parsedFiles.find((item) => item.file.path === scenario.file)!;
    const baseline = sampleReplay(parsed, scenario, scenario.baselineResponse, baselineDoc); const candidate = sampleReplay(parsed, scenario, scenario.candidateResponse, candidateDoc);
    addReads(parsed, baseline); addReads(parsed, candidate); traces.set(scenario.id, baseline);
    const status = checkStatus(baseline.outcome, candidate.outcome);
    checks.push({ id: `CHECK-${String(checks.length + 1).padStart(4, '0')}`, scenarioId: scenario.id, file: scenario.file, exportName: scenario.exportName, operation: scenario.operation, status, baseline: baseline.outcome, candidate: candidate.outcome, callsiteIds: [...new Set([...baseline.siteIds, ...candidate.siteIds])], note: checkNotes[status] });
  }
  const callsites = parsedFiles.flatMap((parsed) => parsed.sites.map((site) => site.report));
  const unverifiedFiles = parsedFiles.filter((parsed) => !parsed.sites.length);
  for (const parsed of unverifiedFiles) limitations.push(`${parsed.file.path}: no supported callsite was recognized; this file remains unverified rather than being assumed API-free.`);
  const unverifiedExports = parsedFiles.flatMap((parsed) => [...parsed.functions.keys()].filter((name) => !checks.some((check) => check.file === parsed.file.path && check.exportName === name)).map((name) => `${parsed.file.path}:${name}`));
  for (const name of unverifiedExports) limitations.push(`${name}: no supplied scenario covers this exported function.`);
  const uncovered = callsites.filter((site) => !checks.some((check) => check.callsiteIds.includes(site.id)));
  if (uncovered.length) limitations.push(`${uncovered.length} detected callsite(s) have no executed matching scenario; they remain unverified.`);
  if (!callsites.length) limitations.push('No supported fetch/axios callsites were detected; absence of evidence is not proof that the source has no API dependencies.');
  const patches = createPatches(input, parsedFiles, checks, traces, baselineDoc, candidateDoc, limitations);
  const summary = { files: input.files.length, callsites: callsites.length, resolved: callsites.filter((item) => item.status === 'resolved').length, unknown: callsites.filter((item) => item.status === 'unknown').length, checks: checks.length, passed: checks.filter((item) => item.status === 'pass').length, regressions: checks.filter((item) => item.status === 'regression').length, invalidBaselines: checks.filter((item) => item.status === 'invalid-baseline').length, inconclusive: checks.filter((item) => item.status === 'inconclusive').length, verifiedPatches: patches.filter((item) => item.verification.status === 'verified').length };
  const blocked = contractAnalysis.summary.breaking > 0 || summary.regressions > 0;
  const review = contractAnalysis.summary.potentiallyBreaking > 0 || contractAnalysis.coverage?.status !== 'complete' || summary.unknown > 0 || summary.invalidBaselines > 0 || summary.inconclusive > 0 || !checks.length || !callsites.length || uncovered.length > 0 || unverifiedFiles.length > 0 || unverifiedExports.length > 0 || parsedFiles.some((item) => item.problem !== undefined);
  return { schemaVersion: 1, toolVersion: CALLER_VERSION, generatedAt: new Date().toISOString(), evidenceKind: 'bounded-typescript-replay', inputFingerprint: fingerprintObject(input), sourceFiles: input.files.map((file) => ({ path: file.path, sha256: fingerprintText(file.content).value })), contractAnalysis, callsites, checks, patches, summary, gate: blocked ? 'blocked' : review ? 'review' : 'pass', limitations: [...new Set(limitations)] };
}
function escape(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/([\\`*_{}\[\]<>|])/g, '\\$1'); }
export function renderCallerReport(report: CallerImpactReport, format: 'json' | 'markdown'): string {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;
  const lines = ['# ContractGuard caller impact review', '', `Gate: **${report.gate}** · Evidence: ${report.evidenceKind} · Version: ${report.toolVersion}`, '', `Input SHA-256: \`${report.inputFingerprint.value}\``, '', `Files: ${report.summary.files}; callsites: ${report.summary.callsites}; regressions: ${report.summary.regressions}; inconclusive: ${report.summary.inconclusive}; verified patch proposals: ${report.summary.verifiedPatches}.`, '', '## Source evidence', '', '| Callsite | Source | Operation | Status | Observed fields |', '| --- | --- | --- | --- | --- |'];
  for (const site of report.callsites) lines.push(`| ${site.id} | ${escape(site.file)}:${site.line}:${site.column} | ${escape(`${site.method ?? '?'} ${site.path ?? '?'}`)} | ${site.status} | ${escape(site.fields.map((field) => field.path).join(', '))} |`);
  lines.push('', '## Replay checks', '');
  for (const check of report.checks) lines.push(`### ${escape(check.scenarioId)} — ${check.status}`, '', `${escape(check.file)} · ${escape(check.exportName)}`, '', `Baseline: ${check.baseline.status}; candidate: ${check.candidate.status}.`, '', escape(check.note), '', ...(check.candidate.error ? [`Candidate: ${escape(check.candidate.error)}`, ''] : []));
  lines.push('## Patch proposals', '');
  for (const patch of report.patches) lines.push(`### ${patch.id}: ${escape(patch.file)} — ${patch.verification.status}`, '', escape(patch.verification.reason), '', `Source SHA-256: \`${patch.sourceSha256}\``, '', ...patch.unifiedDiff.split('\n').map((line) => `    ${line}`), '');
  lines.push('## Limitations', '', ...report.limitations.map((item) => `- ${escape(item)}`), '');
  return lines.join('\n');
}
