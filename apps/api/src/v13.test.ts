import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from './app.js';
import type { OpenApiBundleInput } from '@contractguard/core';

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/multifile');
async function fixture(side: 'baseline' | 'candidate'): Promise<OpenApiBundleInput> {
  return { kind: 'bundle', entry: 'openapi.yaml', files: await Promise.all(['openapi.yaml', 'schemas/order.yaml'].map(async (path) => ({
    path, content: await readFile(join(fixtureRoot, side, path), 'utf8'),
  }))) };
}

describe('V1.3 contract packages and coverage API', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'contractguard-api-v13-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  const appOptions = () => ({ dataDirectory: directory, serveWeb: false, aiEnvironment: { CONTRACTGUARD_AI_ENABLED: 'false' } });

  it('analyzes explicit file packages, stores only dependency metadata, and exports original locations and coverage', async () => {
    const app = createApp(appOptions());
    const response = await request(app).post('/api/analyses').send({ baseline: await fixture('baseline'), candidate: await fixture('candidate') });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const result = response.body;
    assert.equal(result.compatible, false);
    assert.equal(result.source.old.bundle.entry, 'openapi.yaml');
    assert.equal(result.source.old.bundle.files.length, 2);
    assert.equal(result.coverage.status, 'partial');
    const changedId = result.changes.find((change: { ruleId: string; location: string }) => change.ruleId === 'SCHEMA_TYPE_CHANGED' && change.location.includes('id'));
    assert.ok(changedId);
    assert.equal(changedId.sourceLocations.old.file, 'schemas/order.yaml');
    assert.match(changedId.sourceLocations.old.pointer, /\/properties\/id/);
    assert.ok(!result.changes.some((change: { location: string; severity: string }) => change.location.includes('note') && change.severity === 'breaking'));
    const stored = (await request(app).get(`/api/analyses/${result.id}`)).body;
    assert.deepEqual(stored.coverage, result.coverage);
    assert.doesNotMatch(JSON.stringify(stored), /additionalProperties: false|openapi: 3\.0\.4/);
    for (const format of ['markdown', 'html']) {
      const exported = await request(app).get(`/api/analyses/${result.id}/report?format=${format}`);
      assert.equal(exported.status, 200);
      assert.match(exported.text, /Analysis coverage/);
      assert.match(exported.text.replaceAll('\\.', '.'), /schemas\/order\.yaml/);
      assert.doesNotMatch(exported.text.replaceAll('\\#', '#'), /order(?:\\)?\.yaml##/);
    }
  });

  it('does not create history for missing, remote, duplicate, or escaped files', async () => {
    const app = createApp(appOptions());
    const baseline = await fixture('baseline');
    const cases = [
      { ...baseline, files: baseline.files.slice(0, 1) },
      { ...baseline, files: [...baseline.files, baseline.files[0]] },
      { ...baseline, entry: '../outside.yaml' },
      { ...baseline, files: baseline.files.map((file) => file.path === 'openapi.yaml'
        ? { ...file, content: file.content.replace('./schemas/order.yaml', 'https://example.invalid/private.yaml') } : file) },
    ];
    for (const candidate of cases) {
      const result = await request(app).post('/api/analyses').send({ baseline, candidate });
      assert.equal(result.status, 400, JSON.stringify(result.body));
      assert.ok(result.body.error.code);
      assert.doesNotMatch(JSON.stringify(result.body), /C:\\\\Users|stack|node_modules/);
    }
    assert.deepEqual((await request(app).get('/api/analyses')).body.analyses, []);
  });

  it('enforces the API contract content budget across all bundle files', async () => {
    const app = createApp({ ...appOptions(), maxSpecBytes: 2048 });
    const input: OpenApiBundleInput = { kind: 'bundle', entry: 'openapi.yaml', files: [
      { path: 'openapi.yaml', content: 'openapi: 3.1.0\npaths: {}' },
      { path: 'unused.yaml', content: '#'.repeat(2100) },
    ] };
    const response = await request(app).post('/api/analyses').send({ baseline: input, candidate: input });
    assert.equal(response.status, 413);
  });

  it('distinguishes no breaking findings from incomplete coverage, including equal unsupported contracts', async () => {
    const app = createApp(appOptions());
    const input = { openapi: '3.1.0', info: { title: 'Coverage', version: '1' }, paths: {}, webhooks: {
      notice: { post: { responses: { 200: { description: 'OK' } } } },
    } };
    const response = await request(app).post('/api/analyses').send({ baseline: input, candidate: input });
    assert.equal(response.status, 201);
    assert.equal(response.body.compatible, true);
    assert.equal(response.body.score, 100);
    assert.equal(response.body.coverage.status, 'partial');
    assert.ok(response.body.coverage.warnings.some((warning: { location: string }) => warning.location.includes('webhooks')));
  });

  it('does not interpret example data as contract references or schema dialects', async () => {
    const app = createApp(appOptions());
    const input = { openapi: '3.1.0', info: { title: 'Examples', version: '1' }, paths: {},
      components: { examples: { literal: { value: { $ref: 'https://example.invalid/not-a-contract', $schema: 'urn:example:data' } } } },
    };
    const response = await request(app).post('/api/analyses').send({ baseline: input, candidate: input });
    assert.equal(response.status, 201);
    assert.equal(response.body.coverage.status, 'complete');
  });

  it('tells the AI about analysis limitations without sending raw package files', async () => {
    let sent = '';
    const app = createApp({ ...appOptions(), aiConfig: { enabled: true, apiKey: 'v13-test-placeholder' }, aiFetch: async (_url, init) => {
      sent = String(init?.body);
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        overview: { headline: 'Review', executiveSummary: 'Check the deterministic findings.', riskLevel: 'high' },
        keyRisks: [], migrationPlan: [], testSuggestions: [], caveats: ['Some contract semantics are not verified.'],
      }) }, finish_reason: 'stop' }] });
    } });
    const created = await request(app).post('/api/analyses').send({ baseline: await fixture('baseline'), candidate: await fixture('candidate') });
    assert.equal(created.status, 201);
    const review = await request(app).post(`/api/analyses/${created.body.id}/ai-review`).send({ language: 'en' });
    assert.equal(review.status, 200, JSON.stringify(review.body));
    assert.equal(review.body.promptVersion, 'ai-explainer-v4');
    assert.match(sent, /analysisCoverage/);
    assert.match(sent, /partial/);
    assert.doesNotMatch(sent, /additionalProperties: false|openapi: 3\.0\.4|v13-test-placeholder/);
  });
});
