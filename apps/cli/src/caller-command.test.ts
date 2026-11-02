import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const cli = fileURLToPath(new URL('./index.js', import.meta.url));
const fixture = resolve(repository, 'fixtures/caller-impact');

describe('review-callers CLI', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'contractguard-caller-command-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('replays real fetch and axios source, verifies both patches, and keeps the original blocked gate', async () => {
    const output = join(directory, 'review.json');
    const patches = join(directory, 'candidates');
    const before = await readFile(join(fixture, 'src/orders.ts'), 'utf8');
    const run = invoke(['--output', output, '--write-patches', patches]);
    assert.equal(run.status, 2, run.stderr);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.evidenceKind, 'bounded-typescript-replay');
    assert.equal(report.summary.regressions, 2);
    assert.equal(report.summary.passed, 1);
    assert.equal(report.summary.verifiedPatches, 2);
    assert.equal(report.gate, 'blocked');
    assert.ok(report.callsites.every((site: { line: number }) => site.line >= 1));
    const manifest = JSON.parse(await readFile(join(patches, 'manifest.json'), 'utf8'));
    assert.equal(manifest.patches.length, 2);
    assert.ok(manifest.patches.every((patch: { verification: { status: string } }) => patch.verification.status === 'verified'));
    assert.match(await readFile(join(patches, 'sources/orders.ts'), 'utf8'), /order\.displayName/);
    assert.equal(await readFile(join(fixture, 'src/orders.ts'), 'utf8'), before);
  });

  it('supports explicit non-gating report output and does not auto-apply candidate patches', () => {
    const run = invoke(['--fail-on', 'never']);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.gate, 'blocked');
    assert.equal(report.summary.verifiedPatches, 2);
  });

  it('rejects overwrite attempts on the contract, sources, and existing report files', async () => {
    const original = await readFile(join(fixture, 'candidate.json'), 'utf8');
    const contract = invoke(['--output', join(fixture, 'candidate.json')]);
    assert.equal(contract.status, 1);
    assert.equal(await readFile(join(fixture, 'candidate.json'), 'utf8'), original);
    const source = invoke(['--output', join(fixture, 'src', 'new.ts')]);
    assert.equal(source.status, 1);
    assert.match(source.stderr, /outside the source root/);
    const existing = join(directory, 'existing.json');
    await writeFile(existing, 'preserve');
    assert.equal(invoke(['--output', existing]).status, 1);
    assert.equal(await readFile(existing, 'utf8'), 'preserve');
  });

  it('rejects a reused patch directory and malformed scenario containers', async () => {
    const patches = join(directory, 'candidates');
    assert.equal(invoke(['--write-patches', patches, '--fail-on', 'never']).status, 0);
    assert.equal(invoke(['--write-patches', patches, '--fail-on', 'never']).status, 1);
    const scenarios = join(directory, 'invalid.json');
    await writeFile(scenarios, '{}');
    const run = invoke(['--scenarios', scenarios]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /JSON array/);
  });
});

function invoke(extra: string[]) {
  return spawnSync(process.execPath, [cli, 'review-callers', join(fixture, 'baseline.json'), join(fixture, 'candidate.json'),
    '--source-root', join(fixture, 'src'), '--scenarios', join(fixture, 'scenarios.json'),
    '--renames', join(fixture, 'field-renames.json'), '--format', 'json', ...extra],
  { cwd: repository, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
}
