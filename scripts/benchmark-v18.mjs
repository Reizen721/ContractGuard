import { PRODUCT_VERSION } from './lib/release-version.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createApp } from '../apps/api/dist/app.js';
import { runPreparedOasdiff } from '../packages/oasdiff/dist/index.js';

// This is an intentionally small, inspectable benchmark of real upstream code
// under controlled provider mutations. It is not a dataset of historical bugs.
const root = resolve(import.meta.dirname, '..');
const fixture = join(root, 'fixtures/project-tests/openapi-fetch');
const registryPath = join(root, 'fixtures/project-tests/registry.json');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: node scripts/benchmark-v18.mjs [--output NEW_DIRECTORY]');
const output = args[1] ? resolve(args[1]) : undefined;
if (output) await mkdir(output, { recursive: false });
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'contractguard-v18-benchmark-')));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requireRoot = createRequire(join(root, 'package.json'));
const requireMcp = createRequire(join(root, 'packages/mcp/package.json'));
const { Client } = requireMcp('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = requireMcp('@modelcontextprotocol/sdk/client/stdio.js');
const vitestEntry = requireRoot.resolve('vitest/vitest.mjs');
const manifest = JSON.parse(await readFile(registryPath, 'utf8'));
const provenance = JSON.parse(await readFile(join(fixture, 'provenance.json'), 'utf8'));
const expected = {
  'upstream-control': { baselineFailures: 0, candidateFailures: 0, tests: 'pass', gate: 'review', breaking: false },
  'upstream-field-rename': { baselineFailures: 0, candidateFailures: 1, tests: 'regression', gate: 'blocked', breaking: true },
  'upstream-status-change': { baselineFailures: 0, candidateFailures: 1, tests: 'regression', gate: 'blocked', breaking: true },
  'upstream-behavior-only': { baselineFailures: 0, candidateFailures: 1, tests: 'regression', gate: 'blocked', breaking: false },
  'upstream-invalid-baseline': { baselineFailures: 1, candidateFailures: 0, tests: 'invalid-baseline', gate: 'review', breaking: false },
  'upstream-uncovered-route': { baselineFailures: 0, candidateFailures: 0, tests: 'pass', gate: 'review', breaking: false },
};
const results = [];
let app, server, apiUrl, client;

async function treeFingerprint(directory) {
  const entries = [];
  async function visit(current, prefix = '') {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Unexpected fixture link: ${path}`);
      if (entry.isDirectory()) await visit(join(current, entry.name), path);
      else entries.push({ path, sha256: sha256(await readFile(join(current, entry.name))) });
    }
  }
  await visit(directory);
  return { entries, sha256: sha256(JSON.stringify(entries)) };
}

// Independent reference invocation: deliberately does not call ProjectRegistry
// or runProjectTests. Both sides run the same original tests in fresh copies.
async function directVitest(project, phase) {
  const workspace = join(temporary, 'direct', project.id, phase);
  await mkdir(workspace, { recursive: true });
  for (const path of project.include) await cp(join(fixture, path), join(workspace, path), { recursive: true, errorOnExist: true });
  for (const overlay of project.tests[phase] ?? []) await writeFile(join(workspace, overlay.target), await readFile(join(fixture, overlay.source)));
  await mkdir(join(workspace, 'node_modules'));
  await symlink(dirname(vitestEntry), join(workspace, 'node_modules/vitest'), process.platform === 'win32' ? 'junction' : 'dir');
  const reportPath = join(temporary, `${project.id}-${phase}-direct.json`);
  const commandArgs = [vitestEntry, 'run', '--root', workspace, '--config', join(workspace, project.tests.config), '--maxWorkers=1', '--minWorkers=1', '--no-file-parallelism', '--reporter=json', `--outputFile=${reportPath}`, ...project.tests.files];
  const environment = { PATH: dirname(process.execPath), HOME: workspace, USERPROFILE: workspace, TMP: workspace, TEMP: workspace, TMPDIR: workspace, CI: '1', NO_COLOR: '1', TZ: 'UTC' };
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC']) if (process.env[key]) environment[key] = process.env[key];
  const started = Date.now();
  const exitCode = await new Promise((accept, reject) => {
    const child = spawn(process.execPath, commandArgs, { cwd: workspace, env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let bytes = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Independent Vitest reference exceeded 30 seconds.')); }, 30_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    const retain = (chunk) => { bytes += chunk.length; if (bytes < 65536) chunks.push(chunk); };
    child.stdout.on('data', retain); child.stderr.on('data', retain);
    child.on('close', (code) => { clearTimeout(timer); if (code === null) reject(new Error(Buffer.concat(chunks).toString('utf8'))); else accept(code); });
  });
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const tests = { passed: report.numPassedTests, failed: report.numFailedTests, skipped: report.numPendingTests + (report.numTodoTests ?? 0), total: report.numTotalTests };
  assert.equal(tests.total, 5, `The original GET test file must execute all five tests: ${JSON.stringify(report.testResults.map((file) => ({name:file.name,message:file.message})))}`);
  assert.equal(tests.total, tests.passed + tests.failed + tests.skipped);
  return { exitCode, tests, durationMs: Date.now() - started, failedTests: report.testResults.flatMap((file) => file.assertionResults.filter((test) => test.status === 'failed').map((test) => test.fullName)) };
}
async function http(path, body) {
  const response = await fetch(apiUrl + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const content = await response.text(); assert.ok(response.ok, `${response.status}: ${content}`); return JSON.parse(content);
}
async function invoke(suffix, parameters = {}) {
  const result = await client.callTool({ name: `contractguard_${suffix}`, arguments: parameters }, undefined, { timeout: 60_000 });
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent ?? JSON.parse(result.content.find((part) => part.type === 'text').text);
}
async function awaitRun(id) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const run = await http(`/api/agent/runs/${id}`);
    if (!['queued', 'running'].includes(run.status)) return run;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Run ${id} did not finish.`);
}
function breakingEntries(result) {
  const parsed = JSON.parse(result.stdout);
  return (Array.isArray(parsed) ? parsed : parsed.changes ?? []).filter((entry) => entry.level === 3 || entry.level === 'ERR' || entry.level === 'error' || entry.severity === 'error');
}

try {
  const before = await treeFingerprint(fixture);
  for (const record of provenance.records) {
    const original = record.localPath === 'test/helpers.ts' ? 'upstream/helpers.ts' : record.localPath;
    assert.equal(sha256(await readFile(join(fixture, original))), record.sha256, `Upstream provenance mismatch: ${original}`);
  }
  app = createApp({ dataDirectory: join(temporary, 'history'), projectConfigPath: registryPath, serveWeb: false, aiConfig: { enabled: false }, aiEnvironment: { CONTRACTGUARD_AI_ENABLED: 'false' } });
  server = app.listen(0, '127.0.0.1');
  await new Promise((done, reject) => { server.once('listening', done); server.once('error', reject); });
  apiUrl = `http://127.0.0.1:${server.address().port}`;
  client = new Client({ name: 'contractguard-v18-real-project-benchmark', version: PRODUCT_VERSION });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'packages/mcp/dist/index.js')], cwd: root, env: { CONTRACTGUARD_API_URL: apiUrl }, stderr: 'pipe' }));
  assert.equal((await client.listTools()).tools.length, 19);
  const projectsPage = await invoke('list_projects');
  assert.equal(projectsPage.total, 6);

  for (const project of manifest.projects) {
    const expectation = expected[project.id]; assert.ok(expectation);
    const direct = { baseline: await directVitest(project, 'baseline'), candidate: await directVitest(project, 'candidate') };
    assert.equal(direct.baseline.tests.failed, expectation.baselineFailures);
    assert.equal(direct.candidate.tests.failed, expectation.candidateFailures);
    const input = { baseline: await readFile(join(fixture, project.baseline), 'utf8'), candidate: await readFile(join(fixture, project.candidate), 'utf8') };
    const diff = await runPreparedOasdiff('breaking', input);
    const breaking = breakingEntries(diff); assert.equal(breaking.length > 0, expectation.breaking, `${project.id}: oasdiff result`);
    const started = project.id === 'upstream-control' ? await invoke('start_review', { projectId: project.id, mode: 'workflow' }) : await http('/api/agent/runs', { projectId: project.id, mode: 'workflow' });
    const run = await awaitRun(started.id);
    assert.equal(run.status, 'completed', JSON.stringify(run.error));
    assert.equal(run.verdict, expectation.gate);
    assert.equal(run.projectTests.status, expectation.tests);
    assert.equal(run.projectTests.patchStatus, 'not-proposed');
    assert.equal(run.plannerCalls, 0);
    for (const phase of ['baseline', 'candidate']) {
      assert.deepEqual(run.projectTests[phase].tests, direct[phase].tests, `${project.id}: independent ${phase} counts`);
      assert.equal(run.projectTests[phase].exitCode, direct[phase].exitCode);
    }
    assert.ok(run.requiredTools.includes('caller-analysis') && run.requiredTools.includes('project-tests'));
    assert.ok(run.steps.some((step) => step.tool === 'project-tests' && step.status === 'completed'));
    assert.equal(run.callerReview.gate, expectation.breaking ? 'blocked' : 'review', 'Uninterpretable real wrapper must not become a passing AST replay.');
    const caller = await http(`/api/caller-reviews/${run.callerReview.id}`);
    assert.equal(caller.report.summary.checks, 0);
    if (project.id === 'upstream-control') {
      const mcp = await invoke('get_review', { runId: run.id });
      assert.equal(mcp.projectTests.status, expectation.tests);
      assert.equal(mcp.callerReview.id, run.callerReview.id);
    }
    results.push({ id: project.id, label: project.label, inputKind: 'controlled-provider-mutation-on-real-upstream-tests', expectations: expectation, oasdiff: { version: diff.version, breaking: breaking.length, durationMs: diff.durationMs, exitCode: diff.exitCode }, directTests: direct, contractguard: { runId: run.id, verdict: run.verdict, projectTests: run.projectTests.status, baseline: run.projectTests.baseline.tests, candidate: run.projectTests.candidate.tests, callerGate: run.callerReview.gate, callerChecks: caller.report.summary.checks, patchStatus: run.projectTests.patchStatus, plannerCalls: run.plannerCalls, snapshotFingerprint: run.project.snapshotFingerprint }, status: 'passed' });
    if (output) {
      await writeFile(join(output, `${project.id}.agent.json`), JSON.stringify(run, null, 2) + '\n');
      await writeFile(join(output, `${project.id}.oasdiff.json`), diff.stdout);
    }
    process.stdout.write(`PASS ${project.id}: direct ${direct.baseline.tests.passed}/5 -> ${direct.candidate.tests.passed}/5; Agent ${run.projectTests.status}/${run.verdict}\n`);
  }
  assert.equal((await treeFingerprint(fixture)).sha256, before.sha256, 'Fixture source, tests and mode files must be unchanged.');
  const summary = { schemaVersion: 1, date: new Date().toISOString(), dataset: { repository: provenance.repository, commit: provenance.commit, originalRuntimeTests: 5, projects: 1, cases: results.length, contractOrigin: provenance.benchmarkContracts, adaptations: provenance.adaptations }, method: 'Independent direct Vitest invocation versus fixed oasdiff and actual HTTP/MCP Agent workflow. No cloud model, real provider traffic, human-time or accuracy claims.', preparation: { persistentRegistry: 1, projectEntries: 6, existingTestFiles: 1, rewrittenAssertions: 0, manualCallerResponseScenarios: 0, confirmedFieldMappings: 0, authoredContractProfiles: 3, transportAdapterFiles: 1 }, sourceIntegrity: before, results };
  if (output) await writeFile(join(output, 'results.json'), JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(`V1.8 real-project benchmark: ${results.length}/6 cases passed; original five-test file and upstream runtime unchanged.\n`);
} catch (error) {
  if (output) await writeFile(join(output, 'failure.json'), JSON.stringify({ error: error instanceof Error ? error.stack : String(error), completed: results }, null, 2) + '\n');
  throw error;
} finally {
  await client?.close().catch(() => {});
  await app?.locals.closeAgent?.(); await app?.locals.closeCaller?.();
  if (server?.listening) await new Promise((done) => server.close(done));
  const parent = await realpath(tmpdir()); const actual = await realpath(temporary); const rel = relative(parent, actual);
  if (!isAbsolute(rel) && !rel.includes(sep) && rel.startsWith('contractguard-v18-benchmark-')) await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
