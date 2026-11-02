import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCallerImpact } from '@contractguard/caller';
import { ProjectRegistry, runProjectTests } from '../dist/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const demo = join(root, 'fixtures/project-tests');
async function project(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'contractguard-project-unit-'));
  try {
    await cp(join(demo, 'orders-demo'), join(directory, 'orders-demo'), { recursive: true });
    const config = JSON.parse(await readFile(join(demo, 'demo-registry.json'), 'utf8'));
    const configPath = join(directory, 'registry.json');
    const save = () => writeFile(configPath, JSON.stringify(config));
    await save();
    await fn({ directory, source: join(directory, 'orders-demo'), config, configPath, save, registry: new ProjectRegistry(configPath) });
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}

test('registry prepares deterministic source/fixture snapshots and rejects unknown projects', async () => {
  assert.deepEqual(await new ProjectRegistry().list(), []);
  await project(async ({ registry }) => {
    assert.deepEqual((await registry.list()).map((p) => p.id), ['orders-migration']);
    const first = await registry.prepare('orders-migration'); const second = await registry.prepare('orders-migration');
    assert.deepEqual(first.metadata, second.metadata);
    assert.equal(first.caller.scenarios[0].expected, 'ALICE');
    assert.deepEqual(first.caller.scenarios[0].candidateResponse.body, { id: 'ORD-101', displayName: 'Alice' });
    assert.ok(!JSON.stringify(first.metadata).includes('C:\\'));
    await assert.rejects(registry.prepare('unregistered'), { code: 'PROJECT_NOT_FOUND' });
    await assert.rejects(runProjectTests(structuredClone(first)), { code: 'INVALID_PROJECT_SNAPSHOT' });
  });
});

test('real Node existing tests reproduce a regression and verify a caller-generated patch without source changes', async () => {
  await project(async ({ registry, source }) => {
    const before = await readFile(join(source, 'src/orders.ts'), 'utf8');
    const prepared = await registry.prepare('orders-migration');
    const caller = analyzeCallerImpact(prepared.caller);
    const result = await runProjectTests(prepared, { patches: caller.patches });
    assert.equal(result.status, 'regression'); assert.equal(result.patchStatus, 'verified');
    assert.deepEqual([result.baseline.tests.passed, result.candidate.tests.failed, result.patched.tests.passed], [2, 1, 2]);
    assert.equal(result.baseline.testIdentityHash, result.candidate.testIdentityHash);
    assert.equal(result.baseline.testIdentityHash, result.patched.testIdentityHash);
    assert.equal(await readFile(join(source, 'src/orders.ts'), 'utf8'), before);
  });
});

test('prepared bytes remain stable after source and fixture files change on disk', async () => {
  await project(async ({ registry, source }) => {
    const prepared = await registry.prepare('orders-migration');
    await writeFile(join(source, 'src/orders.ts'), 'throw new Error("Changed after preparation");');
    await writeFile(join(source, 'fixtures/baseline-response.json'), '{}');
    const result = await runProjectTests(prepared);
    assert.equal(result.baseline.status, 'passed'); assert.equal(result.candidate.status, 'failed');
  });
});

test('real test subprocesses do not inherit service tokens or NODE_OPTIONS', async () => {
  await project(async ({ registry, source }) => {
    const file = join(source, 'test/orders.test.mjs');
    await writeFile(file, (await readFile(file, 'utf8')) + '\ntest("no service credential in child", () => { assert.equal(process.env.CONTRACTGUARD_PROJECT_SENTINEL, undefined); assert.equal(process.env.NODE_OPTIONS, undefined); });\n');
    const previous = process.env.CONTRACTGUARD_PROJECT_SENTINEL;
    process.env.CONTRACTGUARD_PROJECT_SENTINEL = 'private-sentinel-never-inherit';
    try {
      const result = await runProjectTests(await registry.prepare('orders-migration'));
      assert.equal(result.baseline.tests.passed, 3); assert.ok(!JSON.stringify(result).includes('private-sentinel-never-inherit'));
    } finally { if (previous === undefined) delete process.env.CONTRACTGUARD_PROJECT_SENTINEL; else process.env.CONTRACTGUARD_PROJECT_SENTINEL = previous; }
  });
});

test('empty and entirely skipped Node test selections are inconclusive', async () => {
  await project(async ({ registry, source }) => {
    const file = join(source, 'test/orders.test.mjs');
    await writeFile(file, 'export {};\n');
    assert.equal((await runProjectTests(await registry.prepare('orders-migration'))).status, 'inconclusive');
    await writeFile(file, 'import {test} from "node:test"; test.skip("not executed", () => {});\n');
    assert.equal((await runProjectTests(await registry.prepare('orders-migration'))).status, 'inconclusive');
  });
});

test('equal counts with different executed test identities do not establish a passing comparison', async () => {
  await project(async ({ registry, source }) => {
    await writeFile(join(source, 'test/orders.test.mjs'), 'import{test}from"node:test";import{readFileSync}from"node:fs";const response=JSON.parse(readFileSync(new URL("./response.json",import.meta.url)));test(response.customerName ? "old test" : "replacement test",()=>{});\n');
    const result = await runProjectTests(await registry.prepare('orders-migration'));
    assert.equal(result.baseline.status, 'passed'); assert.equal(result.candidate.status, 'passed');
    assert.equal(result.status, 'inconclusive'); assert.notEqual(result.baseline.testIdentityHash, result.candidate.testIdentityHash);
  });
});

test('invalid baseline is kept distinct from a candidate regression', async () => {
  await project(async ({ registry, source }) => {
    await writeFile(join(source, 'test/orders.test.mjs'), 'import{test}from"node:test";import assert from"node:assert/strict";test("already broken",()=>assert.fail("baseline fails"));\n');
    const result = await runProjectTests(await registry.prepare('orders-migration'));
    assert.equal(result.status, 'invalid-baseline'); assert.equal(result.patchStatus, 'not-proposed');
  });
});

test('timeouts and cancellation never become passes and do not run later phases', async () => {
  await project(async ({ registry, source, config, save }) => {
    await writeFile(join(source, 'test/orders.test.mjs'), 'import{test}from"node:test";test("pending",async()=>{await new Promise(done=>setTimeout(done,30000));});\n');
    config.projects[0].tests.timeoutMs = 600; await save();
    const timed = await runProjectTests(await registry.prepare('orders-migration'));
    assert.equal(timed.status, 'inconclusive'); assert.match(timed.baseline.reason, /timeout/);
    const controller = new AbortController(); const promise = runProjectTests(await registry.prepare('orders-migration'), { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 150);
    const cancelled = await promise; clearTimeout(timer);
    assert.equal(cancelled.baseline.status, 'cancelled'); assert.equal(cancelled.candidate.status, 'cancelled'); assert.equal(cancelled.candidate.durationMs, 0);
  });
});

test('registry rejects untrusted execution, traversal, arbitrary runners and protected fixture overlays', async () => {
  await project(async ({ config, save, registry }) => {
    const original = structuredClone(config.projects[0]);
    for (const mutate of [
      (p) => { p.tests.trusted = false; }, (p) => { p.include = ['../outside']; },
      (p) => { p.tests.runner = 'powershell'; }, (p) => { p.tests.command = 'npm install'; },
      (p) => { p.tests.candidate[0].target = 'fixtures/expected-label.json'; },
      (p) => { p.tests.candidate[0].target = 'contracts/candidate.json'; },
      (p) => { p.tests.candidate[0].target = 'src/orders.ts'; },
    ]) {
      config.projects[0] = structuredClone(original); mutate(config.projects[0]); await save();
      await assert.rejects(registry.prepare('orders-migration'), { code: 'INVALID_PROJECT_CONFIG' });
    }
  });
});

test('directory links cannot escape the project snapshot', async () => {
  await project(async ({ source, directory, config, save, registry }) => {
    const outside = join(directory, 'outside'); await mkdir(outside); await writeFile(join(outside, 'private.txt'), 'not copied');
    await symlink(outside, join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    config.projects[0].include.push('linked'); await save();
    await assert.rejects(registry.prepare('orders-migration'), { code: 'INVALID_PROJECT_CONFIG' });
  });
});

test('patch provenance rejects wrong hashes, changed tests and invented content', async () => {
  await project(async ({ registry }) => {
    const prepared = await registry.prepare('orders-migration'); const patches = analyzeCallerImpact(prepared.caller).patches;
    for (const mutate of [(p) => { p.sourceSha256 = '0'.repeat(64); }, (p) => { p.file = 'test/orders.test.mjs'; }, (p) => { p.patchedContent += 'extra'; }, (p) => { p.edits[0].before = 'invented'; }]) {
      const changed = structuredClone(patches); mutate(changed[0]);
      await assert.rejects(runProjectTests(prepared, { patches: changed }), { code: 'INVALID_PROJECT_PATCH' });
    }
  });
});

test('real upstream Vitest tests run with exact file and identity evidence', async () => {
  const registry = new ProjectRegistry(join(demo, 'registry.json'));
  const result = await runProjectTests(await registry.prepare('upstream-control'));
  assert.equal(result.status, 'pass'); assert.equal(result.baseline.tests.passed, 5);
  assert.equal(result.candidate.testIdentityHash, result.baseline.testIdentityHash);
});

test('Vitest file filters cannot silently broaden the configured test selection', async () => {
  await project(async ({ source, config, save, registry }) => {
    await mkdir(join(source, 'test/extra/test'), { recursive: true });
    await writeFile(join(source, 'test/selected.test.ts'), 'import {test,expect} from "vitest"; test("selected",()=>expect(1).toBe(1));\n');
    await writeFile(join(source, 'test/extra/test/selected.test.ts'), 'import {test,expect} from "vitest"; test("unselected",()=>expect(1).toBe(1));\n');
    config.projects[0].tests.runner = 'vitest'; config.projects[0].tests.files = ['test/selected.test.ts']; await save();
    const result = await runProjectTests(await registry.prepare('orders-migration'));
    assert.equal(result.status, 'inconclusive'); assert.equal(result.baseline.status, 'inconclusive');
  });
});
