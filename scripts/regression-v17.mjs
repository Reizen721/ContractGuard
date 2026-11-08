import { PRODUCT_VERSION } from './lib/release-version.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../apps/api/dist/app.js';
import { analyzeCallerImpact } from '../packages/caller/dist/index.js';

const root = resolve(import.meta.dirname, '..');
const requireMcp = createRequire(join(root, 'packages/mcp/package.json'));
const { Client } = requireMcp('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = requireMcp('@modelcontextprotocol/sdk/client/stdio.js');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: node scripts/regression-v17.mjs [--output NEW_DIRECTORY]');
const output = args[1] ? resolve(args[1]) : undefined;
if (output) await mkdir(output, { recursive: false });
const directory = await mkdtemp(join(tmpdir(), 'contractguard-caller-v17-'));
const dataDirectory = join(directory, 'history');
const input = JSON.parse(await readFile(join(root, 'fixtures/caller-impact/input.json'), 'utf8'));
const cases = JSON.parse(await readFile(join(root, 'fixtures/caller-impact/cases.json'), 'utf8')).cases;
const results = [];
let app, server, apiUrl, client;
const hash = (text) => createHash('sha256').update(text).digest('hex');
const originals = await Promise.all(input.files.map(async ({ path: file }) => ({ file, hash: hash(await readFile(join(root, 'fixtures/caller-impact/src', file))) })));
function record(id, evidence = {}) { results.push({ id, status: 'passed', ...evidence }); process.stdout.write(`PASS ${id}\n`); }
async function startApi() {
  app = createApp({ dataDirectory, serveWeb: false, aiConfig: { enabled: false }, aiEnvironment: { CONTRACTGUARD_AI_ENABLED: 'false' } });
  server = app.listen(0, '127.0.0.1');
  await new Promise((done, reject) => { server.once('listening', done); server.once('error', reject); });
  apiUrl = `http://127.0.0.1:${server.address().port}`;
}
async function closeApi() {
  await app?.locals.closeCaller?.();
  await app?.locals.closeAgent?.();
  if (server?.listening) await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
}
async function startMcp() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'packages/mcp/dist/index.js')], cwd: root, env: { CONTRACTGUARD_API_URL: apiUrl }, stderr: 'pipe' });
  client = new Client({ name: 'contractguard-v17-regression', version: PRODUCT_VERSION });
  await client.connect(transport);
}
async function invoke(suffix, input = {}) {
  const result = await client.callTool({ name: `contractguard_${suffix}`, arguments: input }, undefined, { timeout: 45_000 });
  assert.equal(result.isError, undefined, `${suffix}: ${JSON.stringify(result)}`);
  return result.structuredContent ?? JSON.parse(result.content.find((item) => item.type === 'text').text);
}
async function http(path, body) {
  const response = await fetch(apiUrl + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const content = await response.text();
  assert.ok(response.ok, `${path}: ${response.status} ${content}`);
  return response.headers.get('content-type')?.includes('application/json') ? JSON.parse(content) : content;
}
async function pages(suffix, input = {}) {
  const collected = []; let offset = 0;
  for (let step = 0; step < 1000; step++) {
    const page = await invoke(suffix, { ...input, offset, limit: 1 });
    collected.push(...page.items);
    if (page.nextOffset === null) { assert.equal(collected.length, page.total); return collected; }
    assert.ok(page.nextOffset > offset); offset = page.nextOffset;
  }
  throw new Error('Pagination did not terminate.');
}
async function exported(id, format) {
  let content = '', offset = 0;
  for (let step = 0; step < 2000; step++) {
    const part = await invoke('export_caller_review', { callerReviewId: id, format, offset, maxCharacters: 1024 });
    content += part.content;
    if (part.nextOffset === null) { assert.equal(content.length, part.totalCharacters); return content; }
    assert.ok(part.nextOffset > offset); offset = part.nextOffset;
  }
  throw new Error('Export did not terminate.');
}
function expected(report, values) {
  for (const [key, value] of Object.entries(values)) {
    if (key === 'unknownMinimum') assert.ok(report.summary.unknown >= value, `unknown minimum ${value}`);
    else assert.equal(key === 'gate' ? report.gate : report.summary[key], value, key);
  }
}
try {
  await startApi();
  await startMcp();
  assert.equal((await client.listTools()).tools.length, 19);
  assert.equal((await invoke('status')).ai.available, false);
  record('19-tools-with-model-disabled');

  for (const scenario of cases) {
    const direct = analyzeCallerImpact(scenario.input);
    expected(direct, scenario.expect);
    const saved = await http('/api/caller-reviews', scenario.input);
    expected(saved.report, scenario.expect);
    for (const key of ['inputFingerprint', 'sourceFiles', 'callsites', 'checks', 'patches', 'summary', 'gate']) assert.deepEqual(saved.report[key], direct[key], `${scenario.id}: ${key}`);
    record(`core-http-${scenario.id}`, { recordId: saved.id, summary: saved.report.summary, gate: saved.report.gate });
  }

  const overview = await invoke('review_callers', input);
  const id = overview.id ?? overview.callerReviewId;
  assert.equal(typeof id, 'string');
  const saved = await http(`/api/caller-reviews/${id}`);
  expected(saved.report, { gate: 'blocked', regressions: 2, passed: 1, verifiedPatches: 2 });
  assert.equal(saved.report.evidenceKind, 'bounded-typescript-replay');
  assert.ok(saved.report.callsites.every((site) => site.line > 0 && site.column > 0));
  for (const source of input.files) assert.equal(saved.report.sourceFiles.find((file) => file.path === source.path).sha256, hash(source.content));
  record('mcp-create-real-source-replay', { recordId: id, gate: saved.report.gate, summary: saved.report.summary });

  for (const patch of saved.report.patches) {
    const source = input.files.find((file) => file.path === patch.file).content;
    assert.equal(patch.sourceSha256, hash(source));
    let revised = source;
    for (const edit of [...patch.edits].sort((a, b) => b.start - a.start)) {
      assert.equal(source.slice(edit.start, edit.end), edit.before);
      revised = revised.slice(0, edit.start) + edit.after + revised.slice(edit.end);
    }
    assert.equal(revised, patch.patchedContent);
    assert.equal(hash(revised), patch.patchedSha256);
    assert.equal(patch.verification.status, 'verified');
    assert.ok(patch.verification.results.length > 0);
    assert.ok(patch.verification.results.every((item) => item.outcome.status === 'passed'));
  }
  record('source-fingerprints-edits-and-patch-verification');

  for (const section of ['callsites', 'checks', 'patches', 'limitations']) assert.deepEqual(await pages('get_caller_review', { callerReviewId: id, section }), saved.report[section]);
  assert.ok((await http('/api/caller-reviews')).reviews.some((item) => item.id === id));
  assert.deepEqual(await http(`/api/caller-reviews/${id}/report?format=json`), saved);
  const markdown = await http(`/api/caller-reviews/${id}/report?format=markdown`);
  assert.equal(typeof markdown, 'string');
  record('history-pagination-and-lossless-exports');

  const countBefore = (await http('/api/caller-reviews')).reviews.length;
  const rejected = await client.callTool({ name: 'contractguard_review_callers', arguments: { ...input, sourceRoot: 'C:/private' } });
  assert.equal(rejected.isError, true);
  const invalid = await fetch(apiUrl + '/api/caller-reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, files: [{ path: '../escape.ts', content: 'export const x=1' }] }) });
  assert.equal(invalid.status, 400);
  assert.equal((await http('/api/caller-reviews')).reviews.length, countBefore);
  record('invalid-inputs-do-not-create-success-history');

  const legacy = await invoke('analyze', { baseline: input.baseline, candidate: input.candidate });
  assert.equal(typeof legacy.id, 'string');
  assert.ok((await pages('list_analyses')).some((item) => item.id === legacy.id));
  assert.equal((await http('/api/caller-reviews')).reviews.length, countBefore);
  record('ordinary-analysis-and-caller-histories-remain-separate');

  await client.close(); client = undefined;
  await closeApi();
  await startApi();
  await startMcp();
  assert.deepEqual(await http(`/api/caller-reviews/${id}/report?format=json`), saved);
  assert.ok((await http('/api/caller-reviews')).reviews.some((item) => item.id === id));
  record('api-and-mcp-restart-restores-exact-report');

  for (const source of originals) assert.equal(hash(await readFile(join(root, 'fixtures/caller-impact/src', source.file))), source.hash);
  record('original-consumer-files-unchanged');
  if (output) {
    await writeFile(join(output, 'caller-report.json'), JSON.stringify(saved, null, 2) + '\n', { flag: 'wx' });
    await writeFile(join(output, 'caller-report.md'), markdown, { flag: 'wx' });
    await writeFile(join(output, 'results.json'), JSON.stringify({ version: PRODUCT_VERSION, createdAt: new Date().toISOString(), status: 'passed', boundary: 'Real core/HTTP/MCP, bounded TypeScript AST replay; synthetic responses; no live business API or cloud model.', results }, null, 2) + '\n', { flag: 'wx' });
  }
  process.stdout.write(`V1.7: ${results.length} checks passed.\n`);
} catch (error) {
  if (output) await writeFile(join(output, 'failure.json'), JSON.stringify({ status: 'failed', error: error.message, results }, null, 2) + '\n', { flag: 'wx' });
  throw error;
} finally {
  await client?.close();
  await closeApi();
  // directory is created above by mkdtemp with this task's fixed prefix.
  assert.ok(directory.startsWith(join(tmpdir(), 'contractguard-caller-v17-')));
  await rm(directory, { recursive: true, force: true });
}
