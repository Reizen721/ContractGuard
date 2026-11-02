import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { CallerImpactReport } from '@contractguard/caller';
import { collectCallerSources, exportCallerPatches, readCallerJson, writeNewCallerReport } from './caller-files.js';

describe('caller source and artifact boundaries', () => {
  let directory: string;
  let root: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'contractguard-cli-callers-'));
    root = join(directory, 'source');
    await mkdir(root);
    await writeFile(join(root, 'client.ts'), 'export async function load() { return 1; }\n');
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('collects only bounded TypeScript files with relative paths and excludes secrets/build outputs', async () => {
    await mkdir(join(root, 'nested'));
    await mkdir(join(root, 'node_modules'));
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'nested', 'view.tsx'), 'export const title = "a";');
    await writeFile(join(root, 'node_modules', 'dependency.ts'), 'dependency');
    await writeFile(join(root, '.git', 'secret.ts'), 'secret');
    await writeFile(join(root, 'dist', 'generated.ts'), 'generated');
    await writeFile(join(root, '.env'), 'PRIVATE_VALUE=not-collected');
    await writeFile(join(root, '.hidden.ts'), 'hidden');
    await writeFile(join(root, 'types.d.ts'), 'declare const a: string;');
    await writeFile(join(root, 'readme.md'), 'not source');
    const collected = await collectCallerSources(root);
    assert.deepEqual(collected.files.map(({ path }) => path), ['client.ts', 'nested/view.tsx']);
    assert.equal(JSON.stringify(collected.files).includes('PRIVATE_VALUE'), false);
  });

  it('rejects directory junctions/symlinks without following files outside the root', async () => {
    const outside = join(directory, 'private');
    await mkdir(outside);
    await writeFile(join(outside, 'private.ts'), 'not-authorized');
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(collectCallerSources(root), /links are not followed/i);
    await assert.rejects(collectCallerSources(join(root, 'linked')), /not a link/i);
  });

  it('rejects a file symlink instead of silently excluding a caller', async (context) => {
    const outside = join(directory, 'private.ts');
    await writeFile(outside, 'outside');
    try { await symlink(outside, join(root, 'linked.ts'), 'file'); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EPERM') { context.skip('Windows file symlink permission unavailable'); return; }
      throw error;
    }
    await assert.rejects(collectCallerSources(root), /links are not followed/i);
  });

  it('fails instead of truncating source content or file coverage', async () => {
    await writeFile(join(root, 'large.ts'), 'x'.repeat(1024 * 1024));
    await assert.rejects(collectCallerSources(root), /256 KiB/);
    await rm(join(root, 'large.ts'));
    await Promise.all(Array.from({ length: 20 }, (_, index) => writeFile(join(root, `extra-${index}.ts`), 'export const v = 1;')));
    await assert.rejects(collectCallerSources(root), /20-file/);
  });

  it('refuses source-tree outputs and never overwrites existing files or hard links', async () => {
    const file = join(root, 'client.ts');
    const contents = await readFile(file, 'utf8');
    await assert.rejects(writeNewCallerReport(file, 'replace', root), /outside the source root/);
    await assert.rejects(writeNewCallerReport(join(root, 'new-report.json'), '{}', root), /outside the source root/);
    const existing = join(directory, 'existing.json');
    await writeFile(existing, 'keep');
    await assert.rejects(writeNewCallerReport(existing, '{}', root), { code: 'EEXIST' });
    await link(file, join(directory, 'hardlink.ts'));
    await assert.rejects(writeNewCallerReport(join(directory, 'hardlink.ts'), 'replace', root), { code: 'EEXIST' });
    assert.equal(await readFile(file, 'utf8'), contents);
    assert.equal(await readFile(existing, 'utf8'), 'keep');
  });

  it('checks the physical output parent when a junction points into the source tree', async () => {
    const alias = join(directory, 'source-alias');
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(writeNewCallerReport(join(alias, 'report.json'), '{}', root), /outside the source root/);
  });

  it('exports only candidate copies and labels bounded verification in a new directory', async () => {
    const destination = join(directory, 'patch-export');
    const original = await readFile(join(root, 'client.ts'), 'utf8');
    const report = sampleReport();
    await exportCallerPatches(destination, report, root);
    const manifest = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'));
    assert.equal(manifest.patches[0].verification.status, 'verified');
    assert.match(manifest.note, /not full application execution/);
    assert.equal(await readFile(join(destination, 'sources', 'client.ts'), 'utf8'), 'export const migrated = true;\n');
    assert.equal(await readFile(join(root, 'client.ts'), 'utf8'), original);
    await assert.rejects(exportCallerPatches(destination, report, root), { code: 'EEXIST' });
  });

  it('rejects invalid patch paths before creating an export directory', async () => {
    const report = sampleReport();
    report.patches[0]!.file = '../outside.ts';
    const destination = join(directory, 'invalid-export');
    await assert.rejects(exportCallerPatches(destination, report, root), /Invalid candidate/);
    await assert.rejects(lstat(destination), { code: 'ENOENT' });
  });

  it('requires JSON input to be a bounded regular file', async () => {
    await assert.rejects(readCallerJson(root), /regular/);
    const path = join(directory, 'scenarios.json');
    await writeFile(path, '{');
    await assert.rejects(readCallerJson(path), /valid JSON/);
  });
});

function sampleReport(): CallerImpactReport {
  return {
    schemaVersion: 1, evidenceKind: 'bounded-typescript-replay', inputFingerprint: { algorithm: 'sha256', value: 'a'.repeat(64) },
    patches: [{ id: 'p1', file: 'client.ts', sourceSha256: 'b'.repeat(64), patchedSha256: 'c'.repeat(64), edits: [],
      unifiedDiff: '--- a/client.ts\n+++ b/client.ts\n', patchedContent: 'export const migrated = true;\n',
      verification: { status: 'verified', checkIds: ['c1'], results: [], reason: 'Test fixture.' } }],
  } as unknown as CallerImpactReport;
}
