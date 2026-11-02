import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createApp } from '../apps/api/dist/app.js';
import { ENGINE_VERSION } from '../packages/core/dist/index.js';

// Resolve the SDK through the adapter workspace instead of relying on hoisted dependencies.
const root = resolve(import.meta.dirname, '..');
const requireMcp = createRequire(join(root, 'packages/mcp/package.json'));
const { Client } = requireMcp('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = requireMcp('@modelcontextprotocol/sdk/client/stdio.js');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: node scripts/regression-v16.mjs [--output directory]');
const output = args[1] ? resolve(args[1]) : undefined;
if (output) await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'contractguard-mcp-regression-'));
const dataDirectory = join(directory, 'analyses');
const fixture = async (name) => JSON.parse(await readFile(join(root, 'fixtures/consumer-impact', name + '.json'), 'utf8'));
const baseline = await fixture('baseline');
const candidate = await fixture('candidate');
const consumerEvidence = await fixture('consumers');
const syntheticKey = 'synthetic-mcp-regression-key-not-a-real-credential';
const results = [];
let app, server, apiUrl, client, transport;
let providerCalls = 0;
let providerBehavior = 'explain';
let holdStarted, holdAborted;
let stderr = '';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
function record(name, extra = {}) { results.push({ name, passed: true, ...extra }); }
async function until(check, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  throw new Error(message);
}

async function fakeProvider(url, init) {
  providerCalls++;
  assert.equal(url, 'https://api.deepseek.com/chat/completions');
  assert.equal(init.headers.Authorization, 'Bearer ' + syntheticKey);
  if (providerBehavior === 'hold') {
    holdStarted = true;
    return new Promise((_, reject) => {
      const abort = () => { holdAborted = true; reject(new DOMException('Synthetic request cancelled', 'AbortError')); };
      if (init.signal.aborted) abort();
      else init.signal.addEventListener('abort', abort, { once: true });
    });
  }
  if (providerBehavior === 'fail') return new Response('Synthetic provider outage', { status: 503 });
  let content;
  if (providerBehavior === 'planner') {
    const payload = JSON.parse(init.body);
    const observation = JSON.parse(payload.messages[1].content);
    const tool = ['validate-candidate', 'validate-baseline', 'changelog', 'native-analysis', 'breaking', 'finish']
      .find((name) => observation.availableTools.includes(name));
    assert.ok(tool);
    content = { tool, purpose: '执行允许的契约检查', ...(tool === 'finish' ? {
      summary: '检查已完成，发布结论以确定性证据为准。',
      recommendations: [{ title: '复核调用方回归', actions: ['修复证据中的回归，再提交新的调用样例。'], evidenceIds: [observation.knownEvidenceIds[0]] }],
    } : {}) };
  } else {
    content = {
      overview: { headline: '检测到兼容性风险', executiveSummary: '请根据确定性报告核对受影响的调用方。', riskLevel: 'high' },
      keyRisks: [], migrationPlan: [], testSuggestions: [], caveats: ['这是集成测试中的模拟模型响应。'],
    };
  }
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }),
    { headers: { 'content-type': 'application/json' } });
}

async function startApi(enabled = true) {
  app = createApp({ dataDirectory, serveWeb: false,
    aiEnvironment: { CONTRACTGUARD_AI_ENABLED: 'false' },
    aiConfig: { enabled, apiKey: syntheticKey, baseUrl: 'https://api.deepseek.com', model: 'mcp-integration-model', timeoutMs: 30_000 },
    aiFetch: fakeProvider,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((done, reject) => { server.once('listening', done); server.once('error', reject); });
  apiUrl = 'http://127.0.0.1:' + server.address().port;
}
async function closeApi() {
  await app?.locals.closeAgent?.();
  if (server?.listening) await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
  app = undefined;
  server = undefined;
}
async function startMcp() {
  stderr = '';
  transport = new StdioClientTransport({ command: process.execPath,
    args: [join(root, 'packages/mcp/dist/index.js')], cwd: root,
    env: { CONTRACTGUARD_API_URL: apiUrl }, stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  client = new Client({ name: 'contractguard-v16-regression', version: '1.0.0' });
  await client.connect(transport);
}
async function closeMcp() {
  if (client) await client.close();
  client = undefined;
  transport = undefined;
}
async function http(path, options = {}) {
  const response = await fetch(apiUrl + path, options);
  const text = await response.text();
  assert.ok(response.ok, path + ': ' + response.status + ' ' + text);
  return response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
}
async function invoke(name, input = {}, options) {
  const result = await client.callTool({ name: 'contractguard_' + name, arguments: input }, undefined,
    { timeout: 90_000, ...options });
  assert.equal(result.isError, undefined, name + ': ' + JSON.stringify(result));
  const value = result.structuredContent ?? JSON.parse(result.content.find((item) => item.type === 'text').text);
  assert.equal(JSON.stringify(value).includes(syntheticKey), false, name + ' exposed the synthetic credential');
  return value;
}
async function rejected(name, input, expectedCode) {
  let result;
  try { result = await client.callTool({ name: 'contractguard_' + name, arguments: input }, undefined, { timeout: 90_000 }); }
  catch (error) {
    if (expectedCode) assert.match(String(error), expectedCode);
    return;
  }
  assert.equal(result.isError, true, 'Expected an MCP tool error: ' + name);
  if (expectedCode) assert.match(JSON.stringify(result), expectedCode);
}
async function exportText(name, input, maxCharacters = 32_000) {
  let text = '', offset = 0, total;
  for (let page = 0; page < 200; page++) {
    const part = await invoke(name, { ...input, offset, maxCharacters });
    assert.equal(part.offset, offset);
    assert.equal(typeof part.content, 'string');
    assert.ok(part.content.length <= maxCharacters);
    total ??= part.totalCharacters;
    assert.equal(part.totalCharacters, total);
    text += part.content;
    if (part.nextOffset === null || part.nextOffset === undefined) {
      assert.equal(text.length, total);
      return text;
    }
    assert.equal(part.nextOffset, offset + part.content.length);
    assert.ok(part.nextOffset > offset);
    offset = part.nextOffset;
  }
  throw new Error('Export did not terminate within its page budget');
}
async function pageAll(name, input = {}, limit = 1) {
  const items = [];
  let offset = 0, total;
  for (let page = 0; page < 100; page++) {
    const part = await invoke(name, { ...input, offset, limit });
    assert.equal(part.offset, offset);
    assert.equal(part.limit, limit);
    total ??= part.total;
    assert.equal(part.total, total);
    assert.ok(part.items.length <= limit);
    items.push(...part.items);
    if (part.nextOffset === null || part.nextOffset === undefined) { assert.equal(items.length, total); return items; }
    assert.equal(part.nextOffset, offset + part.items.length);
    assert.ok(part.nextOffset > offset);
    offset = part.nextOffset;
  }
  throw new Error('List did not terminate within its page budget');
}
async function waitReview(runId) {
  return until(async () => {
    const run = await invoke('get_review', { runId });
    return ['queued', 'running'].includes(run.status) ? false : run;
  }, 'Review did not finish within integration-test budget', 90_000);
}
async function bundle(side) {
  const files = await Promise.all(['openapi.yaml', 'schemas/order.yaml'].map(async (path) => ({ path,
    content: await readFile(join(root, 'fixtures/multifile', side, path), 'utf8'),
  })));
  return { kind: 'bundle', entry: 'openapi.yaml', files };
}

try {
  await startApi();
  await startMcp();
  const tools = (await client.listTools()).tools;
  const expectedTools = ['status', 'rules', 'analyze', 'get_analysis', 'list_analyses', 'export_analysis',
    'explain_analysis', 'list_explanations', 'export_explanation', 'start_review', 'get_review', 'list_reviews', 'cancel_review', 'export_review'];
  for (const name of expectedTools) assert.ok(tools.some((tool) => tool.name === 'contractguard_' + name), 'Missing tool ' + name);
  assert.ok((await client.listResources()).resources.some((resource) => resource.uri === 'contractguard://guide'));
  assert.match((await client.readResource({ uri: 'contractguard://guide' })).contents[0].text, /untrusted data/);
  assert.ok((await client.listPrompts()).prompts.some((prompt) => prompt.name === 'contractguard_review_api_change'));
  assert.ok((await client.getPrompt({ name: 'contractguard_review_api_change' })).messages.length > 0);
  const status = await invoke('status');
  assert.equal(status.api.version, ENGINE_VERSION);
  assert.equal(status.agent.engine.available, true);
  assert.equal(status.ai.available, true);
  const rules = await pageAll('rules', {}, 50);
  assert.deepEqual(rules, (await http('/api/rules')).rules);
  record('stdio-initialize-discovery-status-and-rules', { tools: tools.length });

  const analysis = await invoke('analyze', { baseline, candidate, consumerEvidence, baselineName: '零售基线', candidateName: '零售候选' });
  const persisted = await http('/api/analyses/' + analysis.id);
  assert.equal(analysis.score, persisted.score);
  assert.equal(analysis.compatible, persisted.compatible);
  assert.deepEqual(analysis.summary, persisted.summary);
  assert.equal(analysis.consumerImpact.gate, 'blocked');
  assert.equal(persisted.consumerImpact.summary.regressions, 3);
  assert.deepEqual(JSON.parse(await exportText('export_analysis', { analysisId: analysis.id, format: 'json' })), persisted);
  assert.deepEqual((await pageAll('get_analysis', { analysisId: analysis.id, section: 'changes' })).map((item) => item.id), persisted.changes.map((item) => item.id));
  const markdown = await exportText('export_analysis', { analysisId: analysis.id, format: 'markdown' }, 256);
  assert.equal(markdown, await http('/api/analyses/' + analysis.id + '/report?format=markdown'));
  assert.equal(await exportText('export_analysis', { analysisId: analysis.id, format: 'html' }), await http('/api/analyses/' + analysis.id + '/report?format=html'));
  record('analysis-consumer-evidence-paged-findings-and-lossless-exports', { analysisId: analysis.id });

  const multi = await invoke('analyze', { baseline: await bundle('baseline'), candidate: await bundle('candidate') });
  const multiFull = await http('/api/analyses/' + multi.id);
  assert.ok(multiFull.summary.total > 0);
  assert.deepEqual(multi.summary, multiFull.summary);
  const httpCreated = await http('/api/analyses', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseline, candidate: baseline, baselineName: 'Created through HTTP' }) });
  assert.equal((await invoke('get_analysis', { analysisId: httpCreated.id })).score, httpCreated.score);
  const analyses = await pageAll('list_analyses');
  assert.deepEqual(analyses.map((item) => item.id), (await http('/api/analyses')).analyses.map((item) => item.id));
  assert.deepEqual(new Set(analyses.map((item) => item.id)), new Set([analysis.id, multi.id, httpCreated.id]));
  record('multifile-dialect-and-shared-http-history-pagination');

  const firstExplanation = await invoke('explain_analysis', { analysisId: analysis.id });
  assert.equal(providerCalls, 1);
  assert.equal((await invoke('explain_analysis', { analysisId: analysis.id })).id, firstExplanation.id);
  assert.equal(providerCalls, 1);
  const refreshed = await invoke('explain_analysis', { analysisId: analysis.id, force: true });
  assert.notEqual(refreshed.id, firstExplanation.id);
  assert.equal(providerCalls, 2);
  assert.deepEqual((await pageAll('list_explanations', { analysisId: analysis.id })).map((item) => item.id), [refreshed.id, firstExplanation.id]);
  assert.deepEqual(JSON.parse(await exportText('export_explanation', { analysisId: analysis.id, reviewId: firstExplanation.id, format: 'json' })), firstExplanation);
  assert.equal(await exportText('export_explanation', { analysisId: analysis.id, reviewId: firstExplanation.id, format: 'markdown' }),
    await http('/api/analyses/' + analysis.id + '/ai-reviews/' + firstExplanation.id + '/report?format=markdown'));
  await closeMcp();
  await startMcp();
  assert.equal((await invoke('explain_analysis', { analysisId: analysis.id })).id, refreshed.id);
  assert.equal(providerCalls, 2);
  assert.deepEqual(await http('/api/analyses/' + analysis.id), persisted, 'AI explanations must not mutate deterministic evidence or release gates');
  record('saved-ai-cache-force-export-and-mcp-process-restart');

  providerBehavior = 'fail';
  await rejected('explain_analysis', { analysisId: analysis.id, force: true }, /AI_/);
  assert.equal((await invoke('list_explanations', { analysisId: analysis.id })).total, 2);
  record('failed-ai-call-is-not-saved');

  providerBehavior = 'hold';
  holdStarted = false; holdAborted = false;
  const controller = new AbortController();
  const pending = client.callTool({ name: 'contractguard_explain_analysis', arguments: { analysisId: analysis.id, force: true } },
    undefined, { signal: controller.signal, timeout: 30_000 }).then(() => undefined, (error) => error);
  await until(() => holdStarted, 'Mock provider did not receive the cancellable request');
  controller.abort();
  assert.ok(await pending, 'Client cancellation should reject the pending call');
  await until(() => holdAborted, 'MCP cancellation did not reach the provider through HTTP');
  assert.equal((await invoke('list_explanations', { analysisId: analysis.id })).total, 2);
  providerBehavior = 'explain';
  record('mcp-cancellation-propagates-to-ai-request');

  const created = await invoke('start_review', { baseline, candidate, consumerEvidence });
  const run = await waitReview(created.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.verdict, 'blocked');
  const fullRun = await http('/api/agent/runs/' + run.id);
  assert.equal(fullRun.steps.length, 5);
  assert.equal(fullRun.plannerCalls, 0);
  assert.equal(fullRun.upstream.breakingCount, 2);
  assert.equal(fullRun.coreAnalysis.consumerImpact.summary.regressions, 3);
  assert.deepEqual(JSON.parse(await exportText('export_review', { runId: run.id, format: 'json' })), fullRun);
  assert.equal(await exportText('export_review', { runId: run.id, format: 'markdown' }), await http('/api/agent/runs/' + run.id + '/report?format=markdown'));
  assert.deepEqual((await pageAll('get_review', { runId: run.id, section: 'steps' })).map((item) => item.tool), fullRun.steps.map((item) => item.tool));
  assert.equal((await pageAll('get_review', { runId: run.id, section: 'recommendations' })).length, fullRun.recommendations.length);
  record('real-engine-workflow-poll-evidence-and-reports', { runId: run.id });

  const missingEvidence = await invoke('start_review', { baseline, candidate: baseline });
  assert.equal((await waitReview(missingEvidence.id)).verdict, 'review');
  const openapi32 = { openapi: '3.2.0', info: { title: 'Native coverage gap', version: '1' }, paths: {} };
  const gap = await invoke('start_review', { baseline: openapi32, candidate: openapi32 });
  assert.equal((await waitReview(gap.id)).verdict, 'review');
  assert.ok((await http('/api/agent/runs/' + gap.id)).nativeUnavailable);
  record('missing-evidence-and-native-coverage-gap-remain-review');

  providerBehavior = 'planner';
  const callsBeforePlanner = providerCalls;
  const planned = await invoke('start_review', { baseline, candidate, consumerEvidence, mode: 'llm' });
  assert.equal((await waitReview(planned.id)).verdict, 'blocked');
  const plannedFull = await http('/api/agent/runs/' + planned.id);
  assert.equal(plannedFull.status, 'completed', JSON.stringify(plannedFull.error));
  assert.equal(plannedFull.plannerCalls, 6);
  assert.equal(providerCalls - callsBeforePlanner, 6);
  assert.equal(plannedFull.steps[0].tool, 'validate-candidate');
  const knownIds = new Set([...plannedFull.steps.map((item) => item.id), ...plannedFull.upstream.findings.map((item) => item.id),
    ...plannedFull.coreAnalysis.changes.map((item) => item.id), ...plannedFull.coreAnalysis.consumerImpact.consumers.flatMap((item) => item.checks.map((check) => check.id))]);
  assert.ok(plannedFull.recommendations.every((item) => item.evidenceIds.length && item.evidenceIds.every((id) => knownIds.has(id))));
  providerBehavior = 'explain';
  record('real-engines-with-simulated-model-orchestration', { calls: 6 });

  const active = await invoke('start_review', { baseline, candidate });
  assert.equal((await invoke('cancel_review', { runId: active.id })).status, 'cancelled');
  assert.equal((await invoke('cancel_review', { runId: active.id })).status, 'cancelled');
  assert.equal((await waitReview(active.id)).status, 'cancelled');
  assert.deepEqual((await pageAll('list_reviews')).map((item) => item.id), (await http('/api/agent/runs')).runs.map((item) => item.id));
  record('background-cancel-is-durable-idempotent-and-visible-in-history');

  await rejected('get_analysis', { analysisId: '../outside' });
  await rejected('analyze', { baseline, candidate, command: 'not-a-supported-input' });
  await rejected('get_review', { runId: '00000000-0000-4000-8000-000000000000' }, /AGENT_NOT_FOUND/);
  const remoteRef = structuredClone(baseline);
  remoteRef.paths['/orders'].post.requestBody.content['application/json'].schema = { $ref: 'https://example.invalid/never-fetch.yaml' };
  await rejected('analyze', { baseline, candidate: remoteRef });
  record('invalid-input-missing-record-and-remote-ref-errors');

  await closeMcp();
  await closeApi();
  await startApi(false);
  await startMcp();
  assert.equal((await invoke('get_analysis', { analysisId: analysis.id })).score, analysis.score);
  assert.equal((await invoke('get_review', { runId: run.id })).verdict, 'blocked');
  assert.equal((await invoke('get_review', { runId: active.id })).status, 'cancelled');
  assert.deepEqual(JSON.parse(await exportText('export_explanation', { analysisId: analysis.id, reviewId: refreshed.id, format: 'json' })), refreshed);
  const callsBeforeDisabled = providerCalls;
  await rejected('explain_analysis', { analysisId: analysis.id }, /AI_DISABLED/);
  await rejected('start_review', { baseline, candidate, mode: 'llm' }, /AGENT_PLANNER_UNAVAILABLE/);
  assert.equal(providerCalls, callsBeforeDisabled);
  record('api-and-mcp-restart-retain-history-disabled-model-preserves-read-access');

  await closeApi();
  await rejected('status', {}, /API_UNREACHABLE/);
  assert.equal(stderr.includes(syntheticKey), false);
  record('service-unavailable-is-explicit-and-does-not-start-second-api');
  if (output) await writeFile(join(output, 'results.json'), JSON.stringify({ engineVersion: ENGINE_VERSION, realCloudCalls: 0, results }, null, 2) + '\n');
  console.log('V1.6: ' + results.length + ' MCP stdio/API/core/oasdiff integration scenarios passed. Only model responses were simulated; no real cloud model was called.');
} finally {
  await closeMcp();
  await closeApi();
  // Only remove the uniquely created test directory, never repository or user data.
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('contractguard-mcp-regression-'));
  await rm(directory, { recursive: true, force: true });
}
