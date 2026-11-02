import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from './app.js';
import { CallerReviewExecutor } from './caller/executor.js';
import type { CallerImpactInput } from '@contractguard/caller';

function fixture(): CallerImpactInput {
  const spec = (field: string) => ({ openapi: '3.0.3', info: { title: 'Caller verification fixture', version: '1' }, paths: { '/profile': { get: { responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', required: [field], properties: { [field]: { type: 'string' } } } } } } } } } } });
  return {
    schemaVersion: 1, baseline: spec('name'), candidate: spec('displayName'),
    files: [{ path: 'src/profile.ts', content: "export async function load() {\n  const response = await fetch('/profile');\n  const data = await response.json();\n  return data.name.toUpperCase();\n}\n" }],
    scenarios: [{ id: 'profile-label', file: 'src/profile.ts', exportName: 'load', args: [], operation: { method: 'GET', path: '/profile' }, baselineResponse: { status: 200, body: { name: 'Ada' } }, candidateResponse: { status: 200, body: { displayName: 'Ada' } }, expected: 'ADA' }],
    fieldRenames: [{ method: 'GET', path: '/profile', from: 'name', to: 'displayName' }],
  };
}

describe('V1.7 caller impact HTTP API', () => {
  let directory: string;
  let apps: ReturnType<typeof createApp>[];
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'contractguard-caller-api-')); apps = []; });
  afterEach(async () => {
    for (const app of apps) { await app.locals.closeCaller?.(); await app.locals.closeAgent?.(); }
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const app = () => {
    const instance = createApp({ dataDirectory: directory, serveWeb: false, aiEnvironment: { CONTRACTGUARD_AI_ENABLED: 'false' } });
    apps.push(instance); return instance;
  };

  it('creates source-located replay evidence and a verified proposed patch without clearing the original gate', async () => {
    const server = app(); const input = fixture(); const original = structuredClone(input);
    const response = await request(server).post('/api/caller-reviews').send(input);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const report = response.body.report;
    assert.equal(report.evidenceKind, 'bounded-typescript-replay');
    assert.equal(report.gate, 'blocked');
    assert.equal(report.checks[0].status, 'regression');
    assert.equal(report.checks[0].baseline.status, 'passed');
    assert.equal(report.patches[0].verification.status, 'verified');
    assert.match(report.patches[0].patchedContent, /data\.displayName/);
    assert.equal(report.callsites[0].file, 'src/profile.ts');
    assert.equal(report.callsites[0].line, 2);
    assert.match(report.sourceFiles[0].sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(input, original);
    const persisted = JSON.parse(await readFile(join(directory, 'caller-reviews', response.body.id + '.json'), 'utf8'));
    assert.deepEqual(persisted, response.body);
    assert.equal(persisted.input, undefined);
    assert.equal(persisted.report.scenarios, undefined);
    assert.equal(persisted.report.files, undefined);
    assert.deepEqual((await request(server).get('/api/analyses')).body.analyses, []);
    assert.deepEqual((await request(server).get('/api/agent/runs')).body.runs, []);
  });

  it('restores its separate history after service recreation and exports the exact saved result', async () => {
    const first = app();
    const created = await request(first).post('/api/caller-reviews').send(fixture());
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await first.locals.closeCaller();
    const reopened = app();
    const detail = await request(reopened).get('/api/caller-reviews/' + created.body.id);
    assert.deepEqual(detail.body, created.body);
    const history = await request(reopened).get('/api/caller-reviews');
    assert.equal(history.body.reviews.length, 1);
    assert.equal(history.body.reviews[0].id, created.body.id);
    assert.equal(history.body.reviews[0].gate, 'blocked');
    assert.equal(history.body.reviews[0].patches, undefined);
    const json = await request(reopened).get(`/api/caller-reviews/${created.body.id}/report?format=json`);
    assert.deepEqual(json.body, created.body);
    const markdown = await request(reopened).get(`/api/caller-reviews/${created.body.id}/report?format=markdown`);
    assert.equal(markdown.status, 200);
    assert.match(markdown.text, new RegExp(created.body.id));
    assert.match(markdown.text, /blocked/);
    assert.match(markdown.text, /displayName/);
  });

  it('rejects unknown fields, source traversal, invalid scenarios and malformed contracts without saving success', async () => {
    const server = app();
    const cases: unknown[] = [null, {}, { ...fixture(), apiKey: 'synthetic-do-not-log' }];
    const traversal = fixture(); traversal.files[0]!.path = '../private.ts'; cases.push(traversal);
    const noExpected = fixture(); delete (noExpected.scenarios[0] as unknown as Record<string, unknown>).expected; cases.push(noExpected);
    const badContract = fixture(); badContract.baseline = 'not an OpenAPI document'; cases.push(badContract);
    for (const input of cases) {
      const response = await request(server).post('/api/caller-reviews').send(input as object);
      assert.equal(response.status, 400, JSON.stringify(response.body));
    }
    assert.deepEqual((await request(server).get('/api/caller-reviews')).body.reviews, []);
  });

  it('returns explicit not-found and identifier/format errors and skips unrelated damaged history', async () => {
    const server = app();
    assert.equal((await request(server).get('/api/caller-reviews/not-a-uuid')).status, 400);
    const missing = await request(server).get('/api/caller-reviews/11111111-1111-4111-8111-111111111111');
    assert.equal(missing.status, 404); assert.equal(missing.body.error.code, 'CALLER_REVIEW_NOT_FOUND');
    assert.equal((await request(server).get('/api/caller-reviews/11111111-1111-4111-8111-111111111111/report?format=html')).status, 400);
    await request(server).get('/api/caller-reviews');
    await writeFile(join(directory, 'caller-reviews', '22222222-2222-4222-8222-222222222222.json'), '{damaged');
    await writeFile(join(directory, 'caller-reviews', '33333333-3333-4333-8333-333333333333.json'), JSON.stringify({ id: 'wrong', report: {} }));
    assert.deepEqual((await request(server).get('/api/caller-reviews')).body.reviews, []);
    const broken = await request(server).get('/api/caller-reviews/22222222-2222-4222-8222-222222222222');
    assert.equal(broken.status, 500); assert.doesNotMatch(broken.text, /contractguard-caller-api-|SyntaxError/);
  });
});

describe('caller worker lifecycle', () => {
  it('rejects a pre-cancelled operation and closes without leaving a worker', async () => {
    const executor = new CallerReviewExecutor(); const abort = new AbortController(); abort.abort();
    await assert.rejects(executor.run(fixture(), abort.signal), { code: 'CALLER_REVIEW_CANCELLED' });
    await executor.close();
    await assert.rejects(executor.run(fixture(), new AbortController().signal), { code: 'CALLER_SERVICE_CLOSED' });
  });
  it('times out bounded execution without returning a success result', async () => {
    const executor = new CallerReviewExecutor(1);
    try { await assert.rejects(executor.run(fixture(), new AbortController().signal), { code: 'CALLER_REVIEW_TIMEOUT' }); }
    finally { await executor.close(); }
  });
  it('bounds concurrent work and propagates cancellation to the active interpreter worker', async () => {
    const executor = new CallerReviewExecutor(15_000, 1); const abort = new AbortController();
    const first = executor.run(fixture(), abort.signal);
    const observed = assert.rejects(first, { code: 'CALLER_REVIEW_CANCELLED' });
    try {
      await assert.rejects(executor.run(fixture(), new AbortController().signal), { code: 'CALLER_SERVICE_BUSY' });
      abort.abort(); await observed;
    } finally { await executor.close(); }
  });
});
