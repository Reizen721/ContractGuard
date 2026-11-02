import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { getOasdiffExecutable, getOasdiffStatus, runOasdiff, runPreparedOasdiff, PINNED_OASDIFF_VERSION } from '../dist/index.js';
import { extractBinary } from '../../../scripts/install-oasdiff.mjs';
import { gzipSync } from 'node:zlib';

const baseline = { openapi: '3.0.3', info: { title: 'Runner test', version: '1' }, paths: { '/items': { get: { responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'string' } } } } } } } } };
const candidate = { ...baseline, paths: {} };
const status = await getOasdiffStatus();
const needsEngine = { skip: !status.available && `Install pinned engine first: ${status.reason}` };

test('runtime pin matches installer lock and every artifact has a checksum', async () => {
  const lock = JSON.parse(await readFile(new URL('../../../config/oasdiff-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.version, PINNED_OASDIFF_VERSION);
  assert.equal(lock.sourceCommit.length, 40);
  for (const asset of Object.values(lock.assets)) assert.match(asset.sha256, /^[a-f0-9]{64}$/);
});

test('missing installation is explicit; a different executable does not satisfy the pin', async () => {
  const missing = await getOasdiffStatus({ executablePath: fileURLToPath(new URL('./not-installed', import.meta.url)) });
  assert.equal(missing.available, false);
  assert.match(missing.reason, /not installed/);
  const mismatch = await getOasdiffStatus({ executablePath: process.execPath });
  assert.equal(mismatch.available, false);
  assert.match(mismatch.reason, /Expected oasdiff/);
  await assert.rejects(runOasdiff(['--help'], { executablePath: process.execPath }), { code: 'VERSION_MISMATCH' });
});

test('trusted execution captures upstream version and rule catalog', needsEngine, async () => {
  assert.match(await getOasdiffExecutable(), /oasdiff(?:\.exe)?$/);
  const result = await runOasdiff(['checks', 'validate', '--format', 'json']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.version, PINNED_OASDIFF_VERSION);
  assert.equal(JSON.parse(result.stdout).length, 121);
});

test('safe commands return upstream JSON and stable side filenames', needsEngine, async () => {
  for (const command of ['validate', 'breaking', 'changelog', 'diff', 'summary', 'flatten', 'upgrade']) {
    const result = await runPreparedOasdiff(command, { baseline, candidate });
    assert.equal(result.exitCode, 0, `${command}: ${result.stderr}`);
    assert.doesNotThrow(() => JSON.parse(result.stdout), command);
    assert.ok(result.args.includes('--allow-external-refs=false'));
    assert.ok(!result.stdout.includes('contractguard-oasdiff-'));
    assert.ok(!result.args.some((arg) => arg.includes('contractguard-oasdiff-')));
    if (command === 'breaking') assert.ok(JSON.parse(result.stdout).some((finding) => finding.id === 'api-path-removed-without-deprecation'));
  }
});

test('upstream invalid-spec findings are resolved nonzero, not an empty success', needsEngine, async () => {
  const result = await runPreparedOasdiff('validate', { baseline: { openapi: '3.0.3', paths: {} }, candidate });
  assert.equal(result.exitCode, 1);
  assert.ok(JSON.parse(result.stdout).length > 0);
});

test('3.2 single documents reach upstream and cross-version equivalents normalize', needsEngine, async () => {
  const modern = structuredClone(baseline);
  modern.openapi = '3.2.0';
  assert.equal((await runPreparedOasdiff('validate', { baseline: modern, candidate })).exitCode, 0);
  const old = structuredClone(baseline);
  old.paths['/items'].get.responses[200].content['application/json'].schema.nullable = true;
  const upgraded = structuredClone(old);
  upgraded.openapi = '3.1.0';
  upgraded.paths['/items'].get.responses[200].content['application/json'].schema = { type: ['string', 'null'] };
  const result = await runPreparedOasdiff('breaking', { baseline: old, candidate: upgraded });
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('explicit local multi-file bundle resolves without enabling file/network access', needsEngine, async () => {
  const entry = structuredClone(baseline);
  entry.paths['/items'].get.responses[200].content['application/json'].schema = { $ref: './schema.json' };
  const bundle = { kind: 'bundle', entry: 'api.json', files: [{ path: 'api.json', content: JSON.stringify(entry) }, { path: 'schema.json', content: '{"type":"string"}' }] };
  const result = await runPreparedOasdiff('breaking', { baseline: bundle, candidate });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).some((finding) => finding.id === 'api-path-removed-without-deprecation'));
});

test('offline interface rejects URLs and filesystem escape before any request', async () => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('{}'); });
  await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
  try {
    for (const reference of [`http://127.0.0.1:${server.address().port}/schema`, 'file:///etc/passwd', '../private.json', 'C:/private.json']) {
      const unsafe = { ...baseline, components: { schemas: { Unsafe: { $ref: reference } } } };
      await assert.rejects(runPreparedOasdiff('validate', { baseline: unsafe, candidate }), { code: 'INVALID_INPUT' });
    }
    const escaped = { kind: 'bundle', entry: '../api.json', files: [{ path: '../api.json', content: JSON.stringify(baseline) }] };
    await assert.rejects(runPreparedOasdiff('validate', { baseline: escaped, candidate }), { code: 'INVALID_INPUT' });
    assert.equal(requests, 0);
  } finally { await new Promise((accept) => server.close(accept)); }
});

test('offline runner ignores ambient oasdiff configuration', needsEngine, async () => {
  const previousConfig = process.env.OASDIFF_CONFIG;
  const previousFormat = process.env.OASDIFF_FORMAT;
  process.env.OASDIFF_CONFIG = 'does-not-exist.yaml';
  process.env.OASDIFF_FORMAT = 'invalid-format';
  try {
    const result = await runPreparedOasdiff('validate', { baseline, candidate });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), []);
  } finally {
    for (const [key, value] of [['OASDIFF_CONFIG', previousConfig], ['OASDIFF_FORMAT', previousFormat]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('output, runtime and cancellation limits reject explicitly', needsEngine, async () => {
  await assert.rejects(runOasdiff(['checks', 'changelog', '--format', 'json'], { maxOutputBytes: 32 }), { code: 'OUTPUT_LIMIT' });
  await assert.rejects(runOasdiff(['checks', 'changelog', '--format', 'json'], { timeoutMs: 1 }), { code: 'TIMEOUT' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runPreparedOasdiff('validate', { baseline, candidate }, { signal: controller.signal }), { code: 'CANCELLED' });
  await assert.rejects(runOasdiff(['--help'], { maxOutputBytes: 0 }), { code: 'INVALID_ARGUMENT' });
});

test('safe command allowlist and JSON graph budgets are enforced', async () => {
  await assert.rejects(runPreparedOasdiff('breaking-files', { baseline, candidate }), { code: 'INVALID_ARGUMENT' });
  const circular = { ...baseline }; circular.self = circular;
  await assert.rejects(runPreparedOasdiff('validate', { baseline: circular, candidate }), { code: 'INVALID_INPUT' });
  await assert.rejects(runPreparedOasdiff('validate', { baseline: ' '.repeat(5 * 1024 * 1024 + 1), candidate }), { code: 'INVALID_INPUT' });
});

test('temporary staged documents are removed after runtime/output failure', needsEngine, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'contractguard-oasdiff-test-'));
  const previous = new Map(['TMP', 'TEMP', 'TMPDIR'].map((key) => [key, process.env[key]]));
  for (const key of previous.keys()) process.env[key] = directory;
  try {
    await assert.rejects(runPreparedOasdiff('breaking', { baseline, candidate }, { timeoutMs: 1 }), { code: 'TIMEOUT' });
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(runPreparedOasdiff('breaking', { baseline, candidate }, { maxOutputBytes: 1 }), { code: 'OUTPUT_LIMIT' });
    assert.deepEqual(await readdir(directory), []);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

function archiveEntry(name, type = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('00000002000\0', 124, 12);
  header.write(type, 156, 1);
  header.fill(32, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, Buffer.alloc(1024, 42), Buffer.alloc(1024)]);
}

test('archive extraction never writes paths or accepts executable symlinks', () => {
  assert.equal(extractBinary(gzipSync(archiveEntry('oasdiff.exe')), 'oasdiff.exe').length, 1024);
  assert.throws(() => extractBinary(gzipSync(archiveEntry('../oasdiff.exe')), 'oasdiff.exe'), /does not contain/);
  assert.throws(() => extractBinary(gzipSync(archiveEntry('oasdiff.exe', '2')), 'oasdiff.exe'), /regular file/);
  const corrupt = archiveEntry('oasdiff.exe'); corrupt[0] = 0;
  assert.throws(() => extractBinary(gzipSync(corrupt), 'oasdiff.exe'), /checksum/);
});
