import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createApp } from '../apps/api/dist/app.js';
import { ENGINE_VERSION } from '../packages/core/dist/index.js';
const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(tmpdir(), 'contractguard-agent-regression-'));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: node scripts/regression-v15.mjs [--output directory]');
const output = args[1] ? resolve(args[1]) : undefined;
if (output) await mkdir(output, { recursive: true });
const fixture = async (name) => JSON.parse(await readFile(join(root, 'fixtures/consumer-impact', name + '.json'), 'utf8'));
const baseline = await fixture('baseline');
const candidate = await fixture('candidate');
const evidence = await fixture('consumers');
const positive = structuredClone(evidence);
positive.consumers[0].interactions[0].response.candidateBody = positive.consumers[0].interactions[0].response.baselineBody;
const missing = structuredClone(positive);
delete missing.consumers[0].interactions[0].response.candidateBody;
const simple32 = { openapi: '3.2.0', info: { title: 'Upstream-only', version: '1' }, paths: {} };
const scenarios = [
  { id: 'retail-breaking', baseline, candidate, consumerEvidence: evidence, expected: 'blocked' },
  { id: 'unchanged-contract-consumer-regression', baseline, candidate: baseline, consumerEvidence: evidence, expected: 'blocked' },
  { id: 'positive-control', baseline, candidate: baseline, consumerEvidence: positive, expected: 'pass' },
  { id: 'missing-candidate-sample', baseline, candidate: baseline, consumerEvidence: missing, expected: 'review' },
  { id: 'missing-consumers', baseline, candidate: baseline, expected: 'review' },
  { id: 'openapi32-native-gap', baseline: simple32, candidate: simple32, expected: 'review' },
  { id: 'invalid-contract', baseline, candidate: { openapi: '3.0.4', paths: {} }, expected: 'blocked', steps: 2 },
];
const results = [];
let app, server, baseUrl;
async function start(overrides = {}) {
  app = createApp({ dataDirectory: join(directory, 'analyses'), serveWeb: false, aiEnvironment: { CONTRACTGUARD_AI_ENABLED: 'false' }, ...overrides });
  server = app.listen(0, '127.0.0.1');
  await new Promise((done, reject) => { server.once('listening', done); server.once('error', reject); });
  baseUrl = 'http://127.0.0.1:' + server.address().port + '/api/agent';
}
async function close() {
  await app?.locals.closeAgent?.();
  if (server?.listening) await new Promise((done) => server.close(done));
}
async function request(path, method = 'GET', body) {
  const response = await fetch(baseUrl + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function wait(id) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const response = await request('/runs/' + id);
    assert.equal(response.status, 200);
    if (!['queued', 'running'].includes(response.body.status)) return response.body;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('Agent task did not finish within integration test budget');
}
async function cli(argv, expected) {
  let result;
  try { result = { ...(await execute(process.execPath, [join(root, 'apps/cli/dist/index.js'), ...argv], { cwd: root, timeout: 90_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CONTRACTGUARD_AI_ENABLED: 'false' } })), code: 0 }; }
  catch (error) { result = { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  assert.equal(result.code, expected, 'CLI exit: ' + result.stderr);
  return result;
}
try {
  await start();
  const status = await request('/status');
  assert.equal(status.body.engine.available, true);
  assert.equal(status.body.engine.pinnedVersion, '1.35.0');
  assert.equal(status.body.llmAvailable, false);
  for (const scenario of scenarios) {
    const { id, expected, steps, ...input } = scenario;
    const created = await request('/runs', 'POST', input);
    assert.equal(created.status, 202, id + JSON.stringify(created.body));
    const run = await wait(created.body.id);
    assert.equal(run.status, 'completed', id + ': ' + JSON.stringify(run.error));
    assert.equal(run.verdict, expected, id);
    assert.equal(run.steps.length, steps ?? 5, id);
    assert.ok(run.steps.every((step) => step.status === 'completed'));
    assert.equal(run.plannerCalls, 0);
    assert.equal(run.engineVersion, ENGINE_VERSION);
    assert.match(run.upstreamVersion, /1\.35\.0/);
    if (id === 'openapi32-native-gap') assert.ok(run.nativeUnavailable);
    if (id === 'unchanged-contract-consumer-regression') {
      assert.equal(run.upstream.breakingCount, 0);
      assert.equal(run.coreAnalysis.consumerImpact.gate, 'blocked');
    }
    const known = new Set([...run.steps.map((step) => step.id), ...run.upstream.findings.map((item) => item.id),
      ...(run.coreAnalysis?.changes.map((item) => item.id) ?? []),
      ...(run.coreAnalysis?.consumerImpact?.consumers.flatMap((consumer) => consumer.checks.map((check) => check.id)) ?? [])]);
    assert.ok(run.recommendations.every((item) => item.evidenceIds.length && item.evidenceIds.every((key) => known.has(key))));
    const exported = await fetch(baseUrl + '/runs/' + run.id + '/report?format=markdown');
    assert.equal(exported.status, 200);
    const markdown = await exported.text();
    assert.ok(markdown.includes(run.id));
    const stored = JSON.parse(await readFile(join(directory, 'analyses/agent-runs', run.id + '.json'), 'utf8'));
    assert.deepEqual(stored, run);
    assert.equal('baseline' in stored, false);
    assert.equal('candidate' in stored, false);
    assert.equal('consumerEvidence' in stored, false);
    results.push({ id, runId: run.id, verdict: run.verdict, completedSteps: run.steps.length, passed: true });
    if (output) {
      await writeFile(join(output, id + '.json'), JSON.stringify(run, null, 2));
      await writeFile(join(output, id + '.md'), markdown);
    }
  }
  // Cancellation stays cancelled after the upstream subprocess responds.
  const active = await request('/runs', 'POST', { baseline, candidate });
  const cancelled = await request('/runs/' + active.body.id + '/cancel', 'POST', {});
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal((await wait(active.body.id)).status, 'cancelled');
  // Agent accepts explicit contents, never a local server path or unknown instructions.
  assert.equal((await request('/runs', 'POST', { baseline, candidate, command: 'anything' })).status, 400);
  const remote = structuredClone(baseline);
  remote.paths['/orders'].post.requestBody.content['application/json'].schema = { $ref: 'https://example.invalid/never-fetch.yaml' };
  const offline = await request('/runs', 'POST', { baseline, candidate: remote });
  assert.equal((await wait(offline.body.id)).status, 'failed');
  assert.notEqual((await wait(offline.body.id)).verdict, 'pass');
  const disabled = await request('/runs', 'POST', { baseline, candidate, mode: 'llm' });
  assert.ok(disabled.status >= 400);
  await close();
  const interruptedId = randomUUID();
  const template = JSON.parse(await readFile(join(directory, 'analyses/agent-runs', results[0].runId + '.json'), 'utf8'));
  template.id = interruptedId; template.status = 'running'; template.finishedAt = undefined;
  template.steps[0].status = 'running';
  await writeFile(join(directory, 'analyses/agent-runs', interruptedId + '.json'), JSON.stringify(template));
  await start();
  assert.equal((await request('/runs/' + results[0].runId)).body.verdict, 'blocked');
  const recovered = (await request('/runs/' + interruptedId)).body;
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.verdict, 'review');
  const inputs = [join(directory, 'baseline.json'), join(directory, 'positive.json')];
  await writeFile(inputs[0], JSON.stringify(baseline));
  await writeFile(inputs[1], JSON.stringify(positive));
  const command = ['agent', inputs[0], inputs[0], '--consumer-evidence', inputs[1], '--data-dir', join(directory, 'cli'), '-f', 'json'];
  const cliRun = JSON.parse((await cli(command, 0)).stdout);
  assert.equal(cliRun.verdict, 'pass');
  assert.equal(cliRun.steps.length, 5);
  await cli(['agent', inputs[0], inputs[0], '--data-dir', join(directory, 'cli-no-evidence'), '-f', 'json'], 2);
  await cli([...command, '--output', inputs[0]], 1);
  assert.deepEqual(JSON.parse(await readFile(inputs[0], 'utf8')), baseline);
  // Exercise the real planner adapter + HTTP API + real tools together; only the cloud reply is simulated.
  await close();
  let modelRequests = 0;
  await start({ aiConfig: { enabled: true, apiKey: 'fixture-secret', baseUrl: 'https://api.deepseek.com', model: 'mock-model' },
    aiFetch: async (url, init) => {
      modelRequests++;
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      assert.equal(init.headers.Authorization, 'Bearer fixture-secret');
      const payload = JSON.parse(init.body);
      assert.equal(payload.response_format.type, 'json_object');
      assert.equal(payload.thinking.type, 'disabled');
      const context = JSON.parse(payload.messages[1].content);
      assert.equal(JSON.stringify(context).includes('DEMO-BOOK'), false);
      const tool = ['validate-candidate', 'validate-baseline', 'changelog', 'native-analysis', 'breaking', 'finish'].find((name) => context.availableTools.includes(name));
      const decision = { tool, purpose: '执行下一项允许的检查', ...(tool === 'finish' ? { summary: '检查已完成，请按确定性结论处理。', recommendations: [{ title: '复核订单调用方', actions: ['处理检查证据中的回归，再提交新样例。'], evidenceIds: [context.knownEvidenceIds[0]] }] } : {}) };
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] }), { headers: { 'content-type': 'application/json' } });
    } });
  const planned = await request('/runs', 'POST', { baseline, candidate, consumerEvidence: evidence, mode: 'llm' });
  assert.equal(planned.status, 202);
  const plannedResult = await wait(planned.body.id);
  assert.equal(plannedResult.status, 'completed', JSON.stringify(plannedResult.error));
  assert.equal(plannedResult.verdict, 'blocked');
  assert.equal(plannedResult.plannerCalls, 6);
  assert.equal(modelRequests, 6);
  assert.equal(plannedResult.steps[0].tool, 'validate-candidate');
  assert.equal(JSON.stringify(plannedResult).includes('fixture-secret'), false);
  if (output) {
    await writeFile(join(output, 'llm-adapter-simulated-response.json'), JSON.stringify(plannedResult, null, 2));
    await writeFile(join(output, 'results.json'), JSON.stringify({ engineVersion: ENGINE_VERSION, scenarios: results, controls: ['cancel', 'input-fields', 'offline-ref', 'disabled-model', 'restart', 'cli-pass', 'cli-review', 'input-overwrite', 'real-tools-simulated-model-adapter'] }, null, 2));
  }
  console.log('V1.5: ' + results.length + ' real-engine Agent scenarios and 9 lifecycle/CLI/planner controls passed. No cloud model was called.');
} finally {
  await close();
  await rm(directory, { recursive: true, force: true });
}
