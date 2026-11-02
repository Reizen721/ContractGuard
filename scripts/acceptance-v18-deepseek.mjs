import { PRODUCT_VERSION } from './lib/release-version.mjs';
// Opt-in live acceptance. Requires a separately started server with its own credential.
// This script never reads, accepts or saves API keys. It is not part of pnpm check.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ProjectRegistry } from '../packages/project/dist/index.js';

const args = process.argv.slice(2);
if (![4, 6].includes(args.length) || args[0] !== '--api-url' || args[2] !== '--output' || args.length === 6 && (args[4] !== '--resume-run' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(args[5]))) throw new Error('Usage: node scripts/acceptance-v18-deepseek.mjs --api-url http://127.0.0.1:PORT --output NEW_DIRECTORY [--resume-run EXISTING_UUID] (without resume, invokes the configured real DeepSeek model)');
const resumeRun = args[5];
const url = new URL(args[1]);
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use an explicit credential-free loopback origin.');
const apiUrl = url.origin, output = resolve(args[3]), root = resolve(import.meta.dirname, '..');
await mkdir(output);
const requireMcp = createRequire(join(root, 'packages/mcp/package.json'));
const { Client } = requireMcp('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = requireMcp('@modelcontextprotocol/sdk/client/stdio.js');
const registry = new ProjectRegistry(join(root, 'fixtures/project-tests/demo-registry.json'));
const before = await registry.prepare('orders-migration');
const checks = [];
let client, runId, controlId, run, lastProgress = '';
const save = (name, value) => writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const pass = (name, details = {}) => { checks.push({ name, passed: true, ...details }); console.log(`PASS ${name}`); };
async function connect() {
  client = new Client({ name: 'contractguard-v18-live-acceptance', version: PRODUCT_VERSION });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'packages/mcp/dist/index.js')], cwd: root, env: { CONTRACTGUARD_API_URL: apiUrl }, stderr: 'pipe' }));
}
async function invoke(name, arguments_ = {}) {
  const result = await client.callTool({ name: `contractguard_${name}`, arguments: arguments_ }, undefined, { timeout: 45_000 });
  assert.ok(!result.isError, `MCP ${name} failed: ${JSON.stringify(result)}`);
  return result.structuredContent ?? JSON.parse(result.content.find((item) => item.type === 'text').text);
}
async function get(path) { const response = await fetch(apiUrl + path, { signal: AbortSignal.timeout(15_000) }); assert.ok(response.ok, `HTTP ${response.status}`); return response.json(); }
async function finished(id) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const view = await invoke('get_review', { runId: id });
    const progress = `${id} ${view.status}, planner calls ${view.plannerCalls}, recorded steps ${view.sections?.steps ?? '?'}`;
    if (progress !== lastProgress) { console.log(progress); lastProgress = progress; }
    if (!['queued', 'running'].includes(view.status)) return get(`/api/agent/runs/${id}`);
    await new Promise((done) => setTimeout(done, 1500));
  }
  throw new Error(`Review deadline exceeded. Inspect saved run ${id} before resubmitting; no automatic retry was made.`);
}
async function exported(id, format) {
  let content = '', offset = 0;
  for (let index = 0; index < 2000; index++) {
    const chunk = await invoke('export_review', { runId: id, format, offset, maxCharacters: 4096 });
    content += chunk.content;
    if (chunk.nextOffset === null) { assert.equal(content.length, chunk.totalCharacters); return content; }
    assert.ok(chunk.nextOffset > offset); offset = chunk.nextOffset;
  }
  throw new Error('Export did not terminate.');
}
try {
  await connect();
  assert.equal((await client.listTools()).tools.length, 19);
  const status = await invoke('status');
  if (!resumeRun) assert.equal(status.agent.llmAvailable, true);
  const profile = status.agent.planner.providers.find((entry) => entry.id === status.agent.planner.activeProfile);
  assert.ok(profile && (resumeRun || profile.available) && /deepseek/i.test(profile.model));
  const projects = await invoke('list_projects'); assert.ok(projects.items.some((item) => item.id === 'orders-migration'));
  await save('service-status.json', status);
  pass('real-server-and-mcp-ready', { adapterVersion: status.adapter.version, profileId: profile.id, model: profile.model });

  const queued = resumeRun ? { id: resumeRun } : await invoke('start_review', { projectId: 'orders-migration', mode: 'llm', providerId: profile.id, goal: '审查登记的订单迁移项目，完成必要的契约、调用方与项目已有测试。根据真实证据说明原始回归、补丁复验及未覆盖范围，给出简洁中文迁移建议。' });
  runId = queued.id;
  await save('submitted.json', { runId, at: new Date().toISOString(), projectId: 'orders-migration', mode: 'llm', profile, resumedExistingRun: Boolean(resumeRun) });
  run = await finished(runId); await save('agent-report.json', run);
  assert.equal(run.status, 'completed', JSON.stringify(run.error));
  assert.equal(run.mode, 'llm'); assert.equal(run.providerId, profile.id);
  assert.ok(run.plannerCalls > run.steps.length);
  for (const tool of ['validate-baseline', 'validate-candidate', 'breaking', 'changelog', 'native-analysis', 'caller-analysis', 'project-tests']) assert.ok(run.steps.some((step) => step.tool === tool && step.status === 'completed'), `Missing ${tool}`);
  assert.ok(run.steps.findIndex((step) => step.tool === 'caller-analysis') < run.steps.findIndex((step) => step.tool === 'project-tests'));
  pass('deepseek-completed-all-required-actions', { runId, calls: run.plannerCalls, tools: run.steps.map((step) => step.tool), elapsedMs: Date.parse(run.finishedAt) - Date.parse(run.startedAt) });

  const caller = await get(`/api/caller-reviews/${run.callerReview.id}`); await save('caller-report.json', caller);
  assert.equal(caller.report.summary.regressions, 1); assert.equal(caller.report.summary.verifiedPatches, 1);
  assert.deepEqual(run.callerReview.summary, caller.report.summary);
  assert.ok((await get('/api/caller-reviews')).reviews.some((item) => item.id === caller.id));
  assert.equal((await invoke('get_caller_review', { callerReviewId: caller.id })).id, caller.id);
  pass('caller-migration-linked-to-shared-history', { callerReviewId: caller.id });

  const tests = run.projectTests;
  assert.equal(tests.status, 'regression'); assert.equal(tests.patchStatus, 'verified'); assert.equal(run.verdict, 'blocked');
  assert.deepEqual([tests.baseline.status, tests.candidate.status, tests.patched.status], ['passed', 'failed', 'passed']);
  assert.deepEqual([tests.baseline.tests.passed, tests.candidate.tests.failed, tests.patched.tests.passed], [2, 1, 2]);
  assert.ok(tests.baseline.testIdentityHash);
  assert.equal(tests.baseline.testIdentityHash, tests.candidate.testIdentityHash); assert.equal(tests.baseline.testIdentityHash, tests.patched.testIdentityHash);
  assert.match(tests.candidate.output, /toUpperCase/);
  assert.deepEqual(tests.snapshotFingerprint, before.metadata.snapshotFingerprint);
  pass('real-project-tests-verify-patch-and-preserve-original-block');

  const ids = new Set([...run.steps.map((step) => step.id), ...run.steps.flatMap((step) => step.evidenceIds), ...run.upstream.findings.map((item) => item.id), ...run.coreAnalysis.changes.map((item) => item.id), ...run.callerReview.checks.map((item) => item.id), ...run.callerReview.patches.map((item) => item.id), 'PROJECT-BASELINE', 'PROJECT-CANDIDATE', 'PROJECT-PATCHED']);
  assert.ok(run.recommendations.length > 0);
  for (const recommendation of run.recommendations) { assert.ok(recommendation.evidenceIds.length > 0); for (const id of recommendation.evidenceIds) assert.ok(ids.has(id), `Unknown citation ${id}`); }
  assert.ok(run.recommendations.some((item) => item.evidenceIds.some((id) => id.startsWith('CALLER-') || id.startsWith('PROJECT-'))));
  pass('model-recommendations-cite-real-migration-evidence');

  for (const section of ['callerChecks', 'callerPatches', 'projectTests']) { const page = await invoke('get_review', { runId, section, limit: 1 }); assert.equal(page.items.length, 1); }
  assert.deepEqual(JSON.parse(await exported(runId, 'json')), run);
  const markdown = await exported(runId, 'markdown');
  assert.equal(markdown, await (await fetch(`${apiUrl}/api/agent/runs/${runId}/report?format=markdown`)).text());
  await writeFile(join(output, 'agent-report.md'), markdown, { flag: 'wx' });
  await client.close(); await connect();
  assert.equal((await invoke('get_review', { runId })).id, runId);
  assert.ok((await get('/api/agent/runs')).runs.some((item) => item.id === runId));
  pass('evidence-pagination-export-and-mcp-reconnect-preserve-report');

  controlId = (await invoke('start_review', { projectId: 'orders-migration', mode: 'workflow' })).id;
  const control = await finished(controlId); await save('workflow-control.json', control);
  assert.equal(control.status, 'completed'); assert.equal(control.plannerCalls, 0);
  assert.equal(control.verdict, run.verdict); assert.deepEqual(control.inputFingerprints, run.inputFingerprints);
  assert.deepEqual(control.callerReview.summary, run.callerReview.summary);
  for (const phase of ['baseline', 'candidate', 'patched']) { assert.equal(control.projectTests[phase].status, tests[phase].status); assert.deepEqual(control.projectTests[phase].tests, tests[phase].tests); assert.equal(control.projectTests[phase].testIdentityHash, tests[phase].testIdentityHash); }
  pass('llm-and-workflow-agree-on-deterministic-results', { controlId });
  assert.deepEqual((await registry.prepare('orders-migration')).metadata, before.metadata);
  pass('original-project-files-unchanged');
  await save('results.json', { version: PRODUCT_VERSION, passed: true, completedAt: new Date().toISOString(), runId, controlId, model: profile.model, profileId: profile.id, plannerCalls: run.plannerCalls, boundary: 'Real configured DeepSeek over the running local service; real MCP/HTTP/core/caller/oasdiff/Node. Synthetic registered order fixture. No real business API and no automatic source writes. No tokens or raw model transcripts retained.', checks });
  console.log(`Live DeepSeek V1.8 acceptance: ${checks.length}/${checks.length} passed. Run ${runId}`);
} catch (error) {
  await save('failure.json', { runId, controlId, message: String(error), checks });
  console.error(`Live acceptance failed. Inspect ${output} and saved history before any retry.`);
  throw error;
} finally { await client?.close(); }
