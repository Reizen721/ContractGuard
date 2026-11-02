import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from './app.js';
import { buildAiReviewMessages } from './ai/prompt.js';

const fixture = async (name: string): Promise<any> => JSON.parse(await readFile(resolve('..', '..', 'fixtures/consumer-impact', name + '.json'), 'utf8'));

describe('V1.4 consumer evidence API', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'contractguard-v14-api-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  const options = () => ({ dataDirectory: directory, serveWeb: false, aiEnvironment: { CONTRACTGUARD_AI_ENABLED: 'false' } });
  const inputs = async () => ({ baseline: await fixture('baseline'), candidate: await fixture('candidate'), consumerEvidence: await fixture('consumers') });

  it('persists reproducible evidence results and migration tasks without storing request/response payloads', async () => {
    const app = createApp(options());
    const input = await inputs();
    input.consumerEvidence.consumers[0].interactions[0].request.body.sku = 'DO-NOT-PERSIST-EXAMPLE-726';
    const response = await request(app).post('/api/analyses').send(input);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.deepEqual(response.body.consumerImpact.summary, { consumers: 3, interactions: 3, checks: 4, passed: 1, regressions: 3, invalidBaselines: 0, inconclusive: 0 });
    assert.equal(response.body.consumerImpact.gate, 'blocked');
    const history = (await request(app).get('/api/analyses')).body.analyses;
    assert.equal(history[0].consumerGate, 'blocked');
    assert.deepEqual(history[0].consumerSummary, response.body.consumerImpact.summary);
    assert.equal(response.body.consumerImpact.migrationTasks.length, 3);
    assert.doesNotMatch(JSON.stringify(response.body), /DO-NOT-PERSIST-EXAMPLE-726/);
    const reopened = await request(createApp(options())).get('/api/analyses/' + response.body.id);
    assert.deepEqual(reopened.body.consumerImpact, response.body.consumerImpact);
    for (const file of await readdir(directory)) {
      if (file.endsWith('.json')) assert.doesNotMatch(await readFile(join(directory, file), 'utf8'), /DO-NOT-PERSIST-EXAMPLE-726/);
    }
    for (const format of ['json', 'markdown', 'html']) {
      const report = await request(app).get(`/api/analyses/${response.body.id}/report?format=${format}`);
      assert.equal(report.status, 200);
      const text = report.text ?? JSON.stringify(report.body);
      assert.ok(text.includes('mobile-checkout') || text.includes('mobile\\-checkout'));
      assert.match(text, /blocked/);
      assert.doesNotMatch(text, /DO-NOT-PERSIST-EXAMPLE-726/);
    }
  });
  it('detects consumer-only failures on identical contracts and sends only bounded result context to AI', async () => {
    const input = await inputs();
    input.candidate = input.baseline;
    const response = await request(createApp(options())).post('/api/analyses').send(input);
    assert.equal(response.status, 201);
    assert.equal(response.body.score, 100);
    assert.equal(response.body.compatible, true);
    assert.equal(response.body.changes.length, 0);
    assert.equal(response.body.consumerImpact.summary.regressions, 1);
    assert.equal(response.body.consumerImpact.gate, 'blocked');
    const messages = buildAiReviewMessages(response.body, { language: 'zh-CN' }, 10);
    const prompt = messages[1]!.content;
    assert.match(prompt, /supplied-examples/);
    assert.match(prompt, /blocked/);
    assert.doesNotMatch(prompt, /order-demo-001|DEMO-BOOK|baselineBody|candidateBody|Checkout team/);
  });
  it('rejects malformed, misspelled, and oversized evidence without saving a report', async () => {
    const app = createApp(options());
    const input = await inputs();
    for (const evidence of [null, {}, { schemaVersion: 1, consumers: [] }, { ...input.consumerEvidence, secret: true },
      { ...input.consumerEvidence, junk: 'x'.repeat(1024 * 1024) }]) {
      const response = await request(app).post('/api/analyses').send({ ...input, consumerEvidence: evidence });
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'INVALID_CONSUMER_EVIDENCE');
    }
    const typo = await request(app).post('/api/analyses').send({ baseline: input.baseline, candidate: input.candidate, consumersEvidence: input.consumerEvidence });
    assert.equal(typo.status, 400);
    assert.deepEqual((await request(app).get('/api/analyses')).body.analyses, []);
  });
  it('preserves a server-owned consumer caveat even when a mock model says low risk', async () => {
    const input = await inputs();
    input.candidate = input.baseline;
    let calls = 0;
    const appOptions = { dataDirectory: directory, serveWeb: false,
      aiConfig: { enabled: true, apiKey: 'synthetic-test-only-key' },
      aiFetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
          overview: { headline: 'Low risk', executiveSummary: 'Mock response, no production assertion.', riskLevel: 'low' },
          keyRisks: [], migrationPlan: [], testSuggestions: [], caveats: Array.from({ length: 6 }, (_, index) => 'Mock caveat ' + index),
        }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    };
    const app = createApp(appOptions);
    const created = await request(app).post('/api/analyses').send(input).expect(201);
    const history = (await request(app).get('/api/analyses')).body.analyses;
    assert.equal(history[0].score, 100);
    assert.equal(history[0].consumerGate, 'blocked');
    const review = await request(app).post(`/api/analyses/${created.body.id}/ai-review`).send({ language: 'zh-CN' }).expect(200);
    assert.equal(review.body.overview.riskLevel, 'low');
    assert.match(review.body.caveats.join(' '), /调用方样例门禁为 blocked/);
    const cached = await request(createApp(appOptions)).post(`/api/analyses/${created.body.id}/ai-review`).send({ language: 'zh-CN' }).expect(200);
    assert.deepEqual(cached.body.caveats, review.body.caveats);
    assert.equal(calls, 1);
  });
  it('escapes consumer-controlled labels in exports and records absence without asserting safety', async () => {
    const input = await inputs();
    input.consumerEvidence.consumers[0].name = '<script>alert(1)</script>';
    const app = createApp(options());
    const result = await request(app).post('/api/analyses').send(input);
    assert.equal(result.status, 201);
    const html = await request(app).get(`/api/analyses/${result.body.id}/report?format=html`);
    assert.match(html.text, /&lt;script&gt;/);
    assert.doesNotMatch(html.text, /<script>alert/);
    const noEvidence = await request(app).post('/api/analyses').send({ baseline: input.baseline, candidate: input.baseline });
    assert.equal(noEvidence.status, 201);
    assert.equal(noEvidence.body.consumerImpact, undefined);
  });
});
