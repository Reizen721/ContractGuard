import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { link, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { analyzeRelease, ENGINE_VERSION } from '../packages/core/dist/index.js';
import { createApp } from '../apps/api/dist/app.js';

const execute = promisify(execFile);
const fixture = async (name) => JSON.parse(await readFile(resolve('fixtures/consumer-impact', name + '.json'), 'utf8'));
const baseline = await fixture('baseline');
const candidate = await fixture('candidate');
const evidence = await fixture('consumers');
const directory = await mkdtemp(join(tmpdir(), 'contractguard-v14-regression-'));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: node scripts/regression-v14.mjs [--output directory]');
const output = args[1] ? resolve(args[1]) : null;
if (output) await mkdir(output, { recursive: true });
let server;
const appOptions = { dataDirectory: join(directory, 'analyses'), serveWeb: false, aiEnvironment: { CONTRACTGUARD_AI_ENABLED: 'false' } };
async function start() {
  server = createApp(appOptions).listen(0, '127.0.0.1');
  await new Promise((ready, reject) => { server.once('listening', ready); server.once('error', reject); });
  return 'http://127.0.0.1:' + server.address().port;
}
async function close() { if (server?.listening) await new Promise((done) => server.close(done)); }
function semantics(result) {
  const { engineVersion, source, policy, score, compatible, summary, changes, coverage, consumerImpact } = result;
  return JSON.parse(JSON.stringify({ engineVersion, source, policy, score, compatible, summary, changes, coverage, consumerImpact }));
}
async function cli(argv, expected) {
  let response;
  try { response = { ...(await execute(process.execPath, [resolve('apps/cli/dist/index.js'), ...argv], { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 })), code: 0 }; }
  catch (error) { response = { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
  assert.equal(response.code, expected, 'Unexpected CLI exit: ' + response.stderr);
  return response;
}
const positive = structuredClone(evidence);
positive.consumers[0].interactions[0].response.candidateBody = positive.consumers[0].interactions[0].response.baselineBody;
const missing = structuredClone(positive);
delete missing.consumers[0].interactions[0].response.candidateBody;
const invalid = structuredClone(positive);
invalid.consumers[0].interactions[0].response.baselineBody = {};
const unknown = structuredClone(positive);
unknown.consumers[0].interactions[0].response.expectation.properties.receiptUrl.pattern = '^/receipts/';
const unmappedCandidate = structuredClone(baseline);
unmappedCandidate.paths['/admin'] = { get: { responses: { 200: { description: 'OK' } } } };
const cases = [
  { id: 'multi-consumer-release', old: baseline, next: candidate, evidence, gate: 'blocked', counts: [1, 3, 0, 0], code: 2 },
  { id: 'unchanged-spec-consumer-regression', old: baseline, next: baseline, evidence, gate: 'blocked', counts: [3, 1, 0, 0], code: 2 },
  { id: 'positive-control', old: baseline, next: baseline, evidence: positive, gate: 'pass', counts: [4, 0, 0, 0], code: 0 },
  { id: 'missing-candidate-evidence', old: baseline, next: baseline, evidence: missing, gate: 'review', counts: [3, 0, 0, 1], code: 0 },
  { id: 'invalid-baseline-evidence', old: baseline, next: baseline, evidence: invalid, gate: 'review', counts: [3, 0, 1, 0], code: 0 },
  { id: 'unsupported-constraint', old: baseline, next: baseline, evidence: unknown, gate: 'review', counts: [3, 0, 0, 1], code: 0 },
  { id: 'unmapped-removed-operation', old: unmappedCandidate, next: baseline, evidence: positive, gate: 'review', counts: [4, 0, 0, 0], code: 0 },
];
const results = [];
try {
  let baseUrl = await start();
  await cli(['compare', resolve('fixtures/consumer-impact/baseline.json'), resolve('fixtures/consumer-impact/baseline.json'),
    '--fail-on', 'never', '--fail-on-consumer', 'regression'], 1);
  for (const scenario of cases) {
    const files = ['old', 'next', 'evidence'].map((key) => join(directory, scenario.id + '-' + key + '.json'));
    await Promise.all(files.map((file, index) => writeFile(file, JSON.stringify([scenario.old, scenario.next, scenario.evidence][index]))));
    // Preserve the same byte representation on every entry point; object inputs intentionally use canonical JSON fingerprints.
    const oldText = JSON.stringify(scenario.old);
    const nextText = JSON.stringify(scenario.next);
    const core = analyzeRelease(oldText, nextText, { consumerEvidence: scenario.evidence });
    assert.equal(core.consumerImpact.gate, scenario.gate, scenario.id);
    const summary = core.consumerImpact.summary;
    assert.deepEqual([summary.passed, summary.regressions, summary.invalidBaselines, summary.inconclusive], scenario.counts, scenario.id);
    const response = await fetch(baseUrl + '/api/analyses', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseline: oldText, candidate: nextText, consumerEvidence: scenario.evidence }) });
    const http = await response.json();
    assert.equal(response.status, 201, JSON.stringify(http));
    assert.deepEqual(semantics(http), semantics(core));
    const common = ['compare', files[0], files[1], '--consumer-evidence', files[2], '--format', 'json', '--fail-on', 'never'];
    assert.deepEqual(semantics(JSON.parse((await cli(common, scenario.code)).stdout)), semantics(core));
    await cli([...common, '--fail-on-consumer', 'review'], scenario.gate === 'pass' ? 0 : 2);
    await cli([...common, '--fail-on-consumer', 'never'], 0);
    if (scenario.id === 'unmapped-removed-operation') {
      assert.ok(core.consumerImpact.unmappedChangeIds.length > 0);
      await cli(['compare', files[0], files[1], '--consumer-evidence', files[2], '--format', 'json', '--fail-on-consumer', 'never'], 2);
    }
    const packFile = join(directory, scenario.id + '.pack.json');
    await cli([...common, '--write-regression-pack', packFile], scenario.code);
    const replay = JSON.parse((await cli(['verify-pack', packFile, '--format', 'json', '--fail-on', 'never'], scenario.gate === 'pass' ? 0 : 2)).stdout);
    assert.deepEqual(semantics(replay), semantics(core), 'Pack replay changed results');
    await cli([...common, '--write-regression-pack', packFile], 1);
    const alias = join(directory, scenario.id + '.hardlink.json');
    await link(packFile, alias);
    await cli(['verify-pack', packFile, '--output', alias], 1);
    if (process.platform === 'win32') await cli(['verify-pack', packFile, '--output', packFile.toUpperCase()], 1);
    const tampered = JSON.parse(await readFile(packFile, 'utf8'));
    tampered.consumerEvidence.consumers[0].name = 'Changed after review';
    const tamperedFile = join(directory, scenario.id + '.tampered.json');
    await writeFile(tamperedFile, JSON.stringify(tampered));
    await cli(['verify-pack', tamperedFile], 1);
    const exports = {};
    for (const format of ['markdown', 'html']) {
      const report = await fetch(baseUrl + '/api/analyses/' + http.id + '/report?format=' + format);
      assert.equal(report.status, 200);
      exports[format] = await report.text();
      assert.ok(exports[format].includes('Consumer evidence'));
      assert.ok(exports[format].includes(scenario.gate));
    }
    if (output) {
      await writeFile(join(output, scenario.id + '.json'), JSON.stringify(http, null, 2));
      await writeFile(join(output, scenario.id + '.pack.json'), await readFile(packFile));
      await writeFile(join(output, scenario.id + '.md'), exports.markdown);
      await writeFile(join(output, scenario.id + '.html'), exports.html);
    }
    results.push({ id: scenario.id, analysisId: http.id, summary, gate: scenario.gate, staticBreaking: core.summary.breaking, status: 'passed' });
  }
  await close();
  baseUrl = await start();
  for (const saved of results) {
    const reopened = await (await fetch(baseUrl + '/api/analyses/' + saved.analysisId)).json();
    assert.deepEqual(reopened.consumerImpact.summary, saved.summary);
    assert.equal(reopened.consumerImpact.gate, saved.gate);
  }
  if (output) await writeFile(join(output, 'results.json'), JSON.stringify({ engine: ENGINE_VERSION, cases: results, source: 'synthetic offline examples; no production services or cloud LLM calls' }, null, 2));
  process.stdout.write('V1.4 regression passed: 7 scenarios across core, real HTTP, CLI, all gates, portable replay/tamper checks, exports and restart persistence.\n');
} finally {
  await close();
  // Exact directory returned by mkdtemp; no user-selected output path is deleted.
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/'));
  await rm(directory, { recursive: true, force: true });
}
