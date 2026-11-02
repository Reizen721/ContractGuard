import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cli = fileURLToPath(new URL('./index.js', import.meta.url));
const registry = resolve(root, 'fixtures/project-tests/demo-registry.json');
function invoke(args: string[] = [], id = 'orders-migration') { return spawnSync(process.execPath, [cli, 'review-project', id, '--registry', registry, ...args], { cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true }); }

test('project CLI executes existing tests across all phases and preserves the original release gate', () => {
  const result = invoke(['--format', 'json']);
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.gate, 'blocked'); assert.equal(report.tests.status, 'regression'); assert.equal(report.tests.patchStatus, 'verified');
  assert.ok(report.contractAnalysis.changes.length > 0); assert.ok(report.contractAnalysis.summary.breaking > 0);
  assert.deepEqual([report.tests.baseline.tests.passed, report.tests.candidate.tests.failed, report.tests.patched.tests.passed], [2, 1, 2]);
  assert.equal(report.tests.baseline.testIdentityHash, report.tests.patched.testIdentityHash);
});

test('project CLI exports a new report and refuses overwrites before running tests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'contractguard-project-cli-'));
  try {
    const output = join(directory, 'review.json');
    assert.equal(invoke(['--format', 'json', '--output', output, '--fail-on', 'never']).status, 0);
    assert.equal(JSON.parse(await readFile(output, 'utf8')).tests.patchStatus, 'verified');
    await writeFile(output, 'retain this report');
    const refused = invoke(['--output', output]); assert.equal(refused.status, 1); assert.match(refused.stderr, /already exists/);
    assert.equal(await readFile(output, 'utf8'), 'retain this report');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('project CLI produces readable phase evidence and rejects unknown project ids', () => {
  const rendered = invoke(['--fail-on', 'never']); assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /\| candidate \| failed \| 1 \| 1 \|/);
  assert.match(rendered.stdout, /not an operating-system sandbox/);
  const missing = invoke([], 'unregistered'); assert.equal(missing.status, 1); assert.match(missing.stderr, /not registered/);
});
