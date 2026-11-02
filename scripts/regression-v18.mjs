import { PRODUCT_VERSION } from './lib/release-version.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createApp } from '../apps/api/dist/app.js';
import { ProjectRegistry } from '../packages/project/dist/index.js';

const root = resolve(import.meta.dirname, '..');
const requireMcp = createRequire(join(root, 'packages/mcp/package.json'));
const { Client } = requireMcp('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = requireMcp('@modelcontextprotocol/sdk/client/stdio.js');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: node scripts/regression-v18.mjs [--output NEW_DIRECTORY]');
const output = args[1] ? resolve(args[1]) : undefined;
if (output) await mkdir(output);
const directory = await mkdtemp(join(tmpdir(), 'contractguard-v18-integration-'));
const registryPath = join(root, 'fixtures/project-tests/demo-registry.json');
const registry = new ProjectRegistry(registryPath);
const results = [], observations = [];
let app, server, apiUrl, client;
const record = (name, evidence = {}) => { results.push({ name, passed: true, ...evidence }); console.log(`PASS ${name}`); };
async function simulatedPlanner(_url, init) {
  const payload = JSON.parse(init.body);
  const observation = JSON.parse(payload.messages[1].content);
  assert.ok(!init.body.includes('return order.') && !init.body.includes('alice@example.test'), 'Raw source or response body must not reach planner');
  assert.ok(!('output' in observation), 'Raw project output must not reach planner');
  observations.push(observation);
  const tool = ['finish', 'project-tests', 'caller-analysis', 'native-analysis', 'changelog', 'breaking', 'validate-candidate', 'validate-baseline'].find((name) => observation.availableTools.includes(name));
  assert.ok(tool);
  if (tool === 'project-tests') assert.ok(observation.completedTools.includes('caller-analysis'));
  const decision = { tool, purpose: '执行本次已授权的必要检查', summary: tool === 'finish' ? '候选迁移的原始风险与两种验证证据分别保留。' : null, recommendations: tool === 'finish' ? [{ title: '复核迁移候选', actions: ['查看项目测试和调用方记录，按已执行范围审查补丁。'], evidenceIds: observation.knownEvidenceIds.filter((id) => id === 'PROJECT-CANDIDATE' || id.startsWith('CALLER-PATCH-')).slice(0, 3) }] : [] };
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] }), { headers: { 'content-type': 'application/json' } });
}
async function start(enabled = true) {
  app = createApp({ dataDirectory: join(directory, 'history'), serveWeb: false, projectConfigPath: registryPath, aiEnvironment: {}, aiConfig: { enabled, apiKey: 'synthetic-v18-test-not-a-credential' }, aiFetch: simulatedPlanner });
  server = app.listen(0, '127.0.0.1');
  await new Promise((yes, no) => { server.once('listening', yes); server.once('error', no); });
  apiUrl = `http://127.0.0.1:${server.address().port}`;
  client = new Client({ name: 'contractguard-v18-regression', version: PRODUCT_VERSION });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'packages/mcp/dist/index.js')], cwd: root, env: { CONTRACTGUARD_API_URL: apiUrl }, stderr: 'pipe' }));
}
async function close() {
  await client?.close(); client = undefined;
  await app?.locals.closeAgent?.(); await app?.locals.closeCaller?.();
  if (server?.listening) await new Promise((yes, no) => server.close((error) => error ? no(error) : yes()));
}
async function invoke(name, args = {}) {
  const result = await client.callTool({ name: `contractguard_${name}`, arguments: args }, undefined, { timeout: 45_000 });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`);
  return result.structuredContent ?? JSON.parse(result.content.find((item) => item.type === 'text').text);
}
async function get(path) { const response = await fetch(apiUrl + path); assert.ok(response.ok); return response.json(); }
async function finished(runId) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const run = await invoke('get_review', { runId });
    if (!['queued', 'running'].includes(run.status)) { assert.equal(run.status, 'completed', JSON.stringify(run)); return get(`/api/agent/runs/${runId}`); }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('Integration review exceeded deadline');
}
async function exportText(runId, format) {
  let text = '', offset = 0;
  for (let page = 0; page < 2000; page++) {
    const chunk = await invoke('export_review', { runId, format, offset, maxCharacters: 1024 });
    text += chunk.content;
    if (chunk.nextOffset === null) { assert.equal(text.length, chunk.totalCharacters); return text; }
    assert.ok(chunk.nextOffset > offset); offset = chunk.nextOffset;
  }
  throw new Error('Export did not terminate');
}
try {
  const registered = await registry.list();
  const projectId = registered[0]?.id; assert.ok(projectId);
  const original = await registry.prepare(projectId);
  await start();
  assert.equal((await client.listTools()).tools.length, 19);
  const discovery = await invoke('list_projects', { limit: 1 });
  assert.equal(discovery.items[0].id, projectId);
  assert.ok(!('root' in discovery.items[0]));
  record('mcp-project-discovery-without-filesystem-paths');

  for (const body of [{ projectId: 'not-registered' }, { projectId, baseline: '{}' }, { projectId, command: 'node arbitrary.js' }]) {
    const response = await fetch(`${apiUrl}/api/agent/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok([400, 404].includes(response.status));
  }
  assert.equal((await get('/api/agent/runs')).runs.length, 0);
  record('invalid-selection-and-overrides-rejected-before-history');

  const queued = await invoke('start_review', { projectId, mode: 'llm' });
  const run = await finished(queued.id);
  assert.equal(run.verdict, 'blocked');
  assert.ok(run.steps.some((step) => step.tool === 'caller-analysis' && step.status === 'completed'));
  assert.ok(run.steps.some((step) => step.tool === 'project-tests' && step.status === 'completed'));
  assert.equal(run.steps.length, 7);
  record('builtin-planner-runs-required-real-tools', { id: run.id, plannerCalls: run.plannerCalls, steps: run.steps.map((step) => step.tool) });

  const caller = await get(`/api/caller-reviews/${run.callerReview.id}`);
  assert.deepEqual(caller.report.summary, run.callerReview.summary);
  assert.ok(caller.report.summary.verifiedPatches > 0);
  assert.ok((await get('/api/caller-reviews')).reviews.some((entry) => entry.id === caller.id));
  record('agent-caller-record-is-shared-with-web-history', { callerReviewId: caller.id });

  assert.equal(run.projectTests.evidenceKind, 'project-test-execution');
  assert.equal(run.projectTests.baseline.status, 'passed');
  assert.equal(run.projectTests.candidate.status, 'failed');
  assert.equal(run.projectTests.patched.status, 'passed');
  assert.equal(run.projectTests.patchStatus, 'verified');
  assert.deepEqual(run.projectTests.snapshotFingerprint, original.metadata.snapshotFingerprint);
  assert.equal(run.projectTests.baseline.testIdentityHash, run.projectTests.patched.testIdentityHash);
  record('existing-tests-reproduce-and-verify-patch-with-original-gate', { tests: run.projectTests.baseline.tests, gate: run.verdict });

  assert.ok(observations.at(-1).knownEvidenceIds.includes('PROJECT-CANDIDATE'));
  assert.ok(observations.at(-1).knownEvidenceIds.some((id) => id.startsWith('CALLER-')));
  assert.ok(observations.every((entry) => !JSON.stringify(entry).includes('AssertionError')));
  for (const item of run.recommendations) for (const id of item.evidenceIds) assert.ok(observations.at(-1).knownEvidenceIds.includes(id));
  record('planner-sees-bounded-evidence-and-valid-citations-only');

  for (const section of ['callerChecks', 'callerPatches', 'projectTests']) {
    const page = await invoke('get_review', { runId: run.id, section, limit: 1 });
    assert.equal(page.items.length, 1); assert.ok(page.total >= 1);
  }
  assert.deepEqual(JSON.parse(await exportText(run.id, 'json')), run);
  assert.equal(await exportText(run.id, 'markdown'), await (await fetch(`${apiUrl}/api/agent/runs/${run.id}/report?format=markdown`)).text());
  record('mcp-evidence-sections-and-lossless-complete-export');

  await close(); await start(false);
  assert.deepEqual(await get(`/api/agent/runs/${run.id}`), run);
  assert.deepEqual(await get(`/api/caller-reviews/${caller.id}`), caller);
  record('api-mcp-restart-restores-linked-evidence-with-model-disabled');

  const input = JSON.parse(await readFile(join(root, 'fixtures/caller-impact/input.json'), 'utf8'));
  const explicit = await invoke('start_review', { baseline: input.baseline, candidate: input.candidate, caller: { files: input.files, scenarios: input.scenarios, fieldRenames: input.fieldRenames }, mode: 'workflow' });
  const explicitRun = await finished(explicit.id);
  assert.ok(explicitRun.callerReview); assert.equal(explicitRun.projectTests, undefined);
  assert.equal(explicitRun.steps.length, 6); assert.equal(explicitRun.plannerCalls, 0);
  record('explicit-migration-input-works-without-project-or-cloud');

  assert.deepEqual((await registry.prepare(projectId)).metadata.sourceFiles, original.metadata.sourceFiles);
  record('original-project-snapshot-unchanged');
  if (output) {
    await writeFile(join(output, 'results.json'), JSON.stringify({ version: PRODUCT_VERSION, status: 'passed', boundary: 'Real Node/Vitest, caller/core/oasdiff, HTTP and MCP. Only planner responses are simulated. No cloud model or business API.', results }, null, 2));
    await writeFile(join(output, 'agent-report.json'), JSON.stringify(run, null, 2));
    await writeFile(join(output, 'caller-report.json'), JSON.stringify(caller, null, 2));
  }
  console.log(`V1.8: ${results.length} integration checks passed; only model decisions simulated.`);
} catch (error) {
  if (output) await writeFile(join(output, 'failure.json'), JSON.stringify({ message: String(error), results }, null, 2));
  throw error;
} finally {
  await close();
  const tempRoot = await realpath(tmpdir()); const target = await realpath(directory); const rel = relative(tempRoot, target);
  if (!isAbsolute(rel) && rel.startsWith('contractguard-v18-integration-') && !rel.includes(sep)) await rm(target, { recursive: true, force: true, maxRetries: 3 });
}
