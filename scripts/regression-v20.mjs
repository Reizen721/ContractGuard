import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createApp } from '../apps/api/dist/app.js';
import { analyzeRelease, createRegressionPack, ENGINE_VERSION, fingerprintObject } from '../packages/core/dist/index.js';
import { analyzeCallerImpact, CALLER_VERSION } from '../packages/caller/dist/index.js';
import { MCP_VERSION } from '../packages/mcp/dist/server.js';
import { PRODUCT_VERSION } from './lib/release-version.mjs';

// Synthetic legacy records exercise the existing schema rather than rewriting user history.
// No cloud credentials, user data directory, network business API or upstream binary is needed.
const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(tmpdir(), 'contractguard-v20-upgrade-'));
const history = join(directory, 'history');
const spec = { openapi: '3.1.0', info: { title: 'Upgrade replay', version: '1' }, paths: { '/orders': { get: { responses: { '200': {
  description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { receipt: { type: 'string' } } } } },
} } } } } };
const evidence = { schemaVersion: 1, consumers: [{ id: 'checkout', name: 'Checkout', owner: 'Web', criticality: 'critical', interactions: [{ id: 'receipt', method: 'GET', path: '/orders', response: { status: '200', mediaType: 'application/json', baselineBody: { receipt: 'sample' }, candidateBody: {}, expectation: { type: 'object', required: ['receipt'] } } }] }] };
let app, server;
let passed = 0;
const pass = (name) => { passed++; console.log(`PASS ${name}`); };
const cli = (...args) => {
  const result = spawnSync(process.execPath, [join(root, 'apps/cli/dist/index.js'), ...args], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  if (result.error) throw result.error;
  assert.equal(result.signal, null);
  return result;
};
try {
  assert.deepEqual([ENGINE_VERSION, CALLER_VERSION, MCP_VERSION], [PRODUCT_VERSION, PRODUCT_VERSION, PRODUCT_VERSION]);
  const version = cli('--version');
  assert.equal(version.status, 0); assert.equal(version.stdout.trim(), PRODUCT_VERSION);
  pass('Runtime core/caller/MCP and CLI advertise the current release');

  const current = createRegressionPack(spec, spec, evidence, { schemaVersion: 1, id: 'legacy-policy' });
  assert.equal(current.schemaVersion, 1); assert.equal(current.engineVersion, PRODUCT_VERSION);
  const { fingerprint: _, ...content } = current;
  const legacyContent = { ...content, engineVersion: '1.5.0' };
  const legacy = { ...legacyContent, fingerprint: fingerprintObject(legacyContent) };
  const packPath = join(directory, 'legacy-pack.json');
  const originalPack = JSON.stringify(legacy, null, 2);
  await writeFile(packPath, originalPack);
  const replay = cli('verify-pack', packPath, '--format', 'json');
  assert.equal(replay.status, 2, replay.stderr);
  const replayed = JSON.parse(replay.stdout);
  assert.equal(replayed.engineVersion, PRODUCT_VERSION);
  assert.equal(replayed.compatible, true); assert.equal(replayed.consumerImpact.gate, 'blocked');
  assert.match(replay.stderr, /compatible legacy pack \(1\.5\.0\)/);
  assert.equal(await readFile(packPath, 'utf8'), originalPack);
  pass('Legacy 1.5.0 CLI replay preserves blocked consumer gate, pack bytes and checksum');

  await writeFile(packPath, JSON.stringify({ ...legacy, candidate: {} }));
  const tampered = cli('verify-pack', packPath, '--format', 'json');
  assert.equal(tampered.status, 1); assert.match(tampered.stderr, /fingerprint mismatch/);
  assert.equal(tampered.stdout, '');
  pass('Legacy replay still rejects edited inputs before analysis');

  const unknown = { ...legacyContent, engineVersion: '2.1.0' };
  await writeFile(packPath, JSON.stringify({ ...unknown, fingerprint: fingerprintObject(unknown) }));
  const unsupported = cli('verify-pack', packPath, '--format', 'json');
  assert.equal(unsupported.status, 1); assert.match(unsupported.stderr, /explicitly compatible/);
  pass('An unknown engine with a valid checksum is rejected');

  const createdAt = '2026-09-20T00:00:00.000Z';
  const coreReport = { ...analyzeRelease(spec, spec, { consumerEvidence: evidence, generatedAt: createdAt }), engineVersion: '1.5.0' };
  const analysis = { ...coreReport, id: randomUUID(), createdAt, baselineName: 'legacy-baseline', candidateName: 'legacy-candidate' };
  const callerInput = JSON.parse(await readFile(join(root, 'fixtures/caller-impact/input.json'), 'utf8'));
  const caller = { id: randomUUID(), createdAt, report: { ...analyzeCallerImpact(callerInput), toolVersion: '1.7.0' } };
  const agent = {
    schemaVersion: 1, id: randomUUID(), mode: 'workflow', status: 'completed', createdAt, updatedAt: createdAt,
    startedAt: createdAt, finishedAt: createdAt, baselineName: 'legacy-baseline', candidateName: 'legacy-candidate',
    goal: 'Preserve legacy review', engineVersion: '1.5.0', upstreamVersion: '1.35.0',
    inputFingerprints: { baseline: fingerprintObject(spec), candidate: fingerprintObject(spec) },
    verdict: 'blocked', steps: [], coreAnalysis: coreReport,
    upstream: { validationErrors: 0, breakingCount: 0, warningCount: 0, findings: [], truncated: false },
    summary: 'Legacy saved review', recommendations: [], limitations: ['Synthetic upgrade fixture'], plannerCalls: 0,
  };
  const records = [
    { file: join(history, analysis.id + '.json'), value: analysis },
    { file: join(history, 'caller-reviews', caller.id + '.json'), value: caller },
    { file: join(history, 'agent-runs', agent.id + '.json'), value: agent },
  ];
  await mkdir(join(history, 'caller-reviews'), { recursive: true });
  await mkdir(join(history, 'agent-runs'), { recursive: true });
  for (const record of records) { record.bytes = JSON.stringify(record.value, null, 2); await writeFile(record.file, record.bytes); }
  app = createApp({ dataDirectory: history, serveWeb: false, aiConfig: { enabled: false }, aiEnvironment: {} });
  server = app.listen(0, '127.0.0.1');
  await new Promise((yes, no) => { server.once('listening', yes); server.once('error', no); });
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  async function get(path) { const response = await fetch(apiUrl + path, { signal: AbortSignal.timeout(10_000) }); assert.equal(response.status, 200, path); return response.json(); }
  assert.equal((await get('/api/health')).version, PRODUCT_VERSION);
  pass('API health reports the current release');
  for (const [path, expected, listKey] of [
    ['/api/analyses', analysis, 'analyses'], ['/api/caller-reviews', caller, 'reviews'], ['/api/agent/runs', agent, 'runs'],
  ]) {
    assert.deepEqual(await get(`${path}/${expected.id}`), expected);
    assert.equal((await get(path))[listKey].some((item) => item.id === expected.id), true);
    assert.deepEqual(await get(`${path}/${expected.id}/report?format=json`), expected);
    pass(`Legacy ${listKey} remains readable, listed and exportable with its original version`);
  }
  for (const { file, bytes } of records) assert.equal(await readFile(file, 'utf8'), bytes);
  pass('Reading completed schemaVersion 1 history leaves persisted bytes unchanged');
  console.log(`V2.0 upgrade regression: ${passed} checks passed.`);
} finally {
  await app?.locals.closeAgent?.(); await app?.locals.closeCaller?.();
  if (server?.listening) await new Promise((yes, no) => server.close((error) => error ? no(error) : yes()));
  const temporaryPath = relative(resolve(tmpdir()), resolve(directory));
  assert.ok(temporaryPath && !isAbsolute(temporaryPath) && temporaryPath !== '..' && !temporaryPath.startsWith('..' + sep));
  await rm(directory, { recursive: true, force: true });
}
