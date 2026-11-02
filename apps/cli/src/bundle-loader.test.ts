import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadLocalContract } from './bundle-loader.js';

describe('CLI local file boundary', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'contractguard-cli-v13-'));
    await mkdir(join(directory, 'contracts', 'schemas'), { recursive: true });
    await writeFile(join(directory, 'contracts', 'openapi.yaml'), `openapi: 3.1.0\npaths:\n  /items:\n    get:\n      responses:\n        '200':\n          description: OK\n          content:\n            application/json:\n              schema:\n                $ref: './schemas/item.yaml'\n`);
    await writeFile(join(directory, 'contracts', 'schemas', 'item.yaml'), 'type: string\n');
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('loads only referenced files and preserves package-relative paths', async () => {
    await writeFile(join(directory, 'contracts', 'unrelated.yaml'), 'not valid YAML: [');
    const bundle = await loadLocalContract(join(directory, 'contracts', 'openapi.yaml'));
    assert.equal(bundle.entry, 'openapi.yaml');
    assert.deepEqual(bundle.files.map((file) => file.path).sort(), ['openapi.yaml', 'schemas/item.yaml']);
  });

  it('rejects an entry outside the explicitly selected root', async () => {
    await assert.rejects(loadLocalContract(join(directory, 'contracts', 'openapi.yaml'), join(directory, 'contracts', 'schemas')), /inside/);
  });

  it('does not follow package references outside the allowed root', async () => {
    const entry = join(directory, 'contracts', 'openapi.yaml');
    await writeFile(entry, `openapi: 3.1.0\npaths:\n  /x:\n    $ref: '../outside.yaml'\n`);
    await writeFile(join(directory, 'outside.yaml'), 'get: {}');
    await assert.rejects(loadLocalContract(entry), /root|escape|outside|traversal|path|包|边界/i);
  });

  it('rejects a linked dependency instead of reading it', async (context) => {
    const target = join(directory, 'contracts', 'schemas', 'item.yaml');
    await rm(target);
    await writeFile(join(directory, 'outside.yaml'), 'type: number\n');
    try { await symlink(join(directory, 'outside.yaml'), target, 'file'); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EPERM') { context.skip('Windows symlink permission unavailable'); return; }
      throw error;
    }
    await assert.rejects(loadLocalContract(join(directory, 'contracts', 'openapi.yaml')), /symbolic link|inside the root/);
  });
});
