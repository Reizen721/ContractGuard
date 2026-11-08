import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import request from 'supertest';
import { createApp } from './app.js';
import { CEGAR_PRESETS, runCegarMigration } from './cegar/engine.js';

test('CEGAR preset 1 (nested + nullable): Round 1 passes nominal but catches WIT-NULL crash, Round 2 refines to verified', async () => {
  const preset = CEGAR_PRESETS.find((p) => p.id === 'preset-nested-nullable')!;
  const record = await runCegarMigration(preset.request);

  assert.equal(record.releaseGate, 'blocked');
  assert.equal(record.callerImpactStatus, 'regression-repaired-verified');
  assert.equal(record.patchStatus, 'verified');
  assert.equal(record.rounds.length, 2);

  // Round 1: nominal passed, compiler clean, but adversarial WIT-NULL caught crash!
  const r1 = record.rounds[0]!;
  assert.equal(r1.verification.compilerClean, true);
  assert.equal(r1.verification.nominalPassed, true);
  assert.equal(r1.verification.verified, false);
  assert.ok(r1.counterexamples.some((c) => c.kind === 'adversarial-witness-crash' && c.witnessId?.startsWith('WIT-NULL')));

  // Round 2: counterexample-guided refinement repairs null dereference and verifies 100%!
  const r2 = record.rounds[1]!;
  assert.equal(r2.verification.verified, true);
  assert.equal(r2.verification.adversarialPassed, r2.verification.adversarialTotal);
  assert.ok(r2.citedCounterexampleIds.length > 0);
  assert.equal(record.finalPatches.length, 1);
  assert.match(record.finalPatches[0]!.patchedContent, /\?\?/);
});

test('CEGAR preset 2 (enum rename + new variant): Round 1 remaps DISPATCHED->IN_TRANSIT, catches WIT-ENUM, Round 2 fixes switch default', async () => {
  const preset = CEGAR_PRESETS.find((p) => p.id === 'preset-enum-switch')!;
  const record = await runCegarMigration(preset.request);

  assert.equal(record.callerImpactStatus, 'regression-repaired-verified');
  assert.equal(record.patchStatus, 'verified');
  assert.equal(record.rounds.length, 2);
  assert.equal(record.rounds[0]!.verification.nominalPassed, true);
  assert.equal(record.rounds[0]!.verification.verified, false);
  assert.ok(record.rounds[0]!.counterexamples.some((c) => c.witnessId?.startsWith('WIT-ENUM')));
  assert.equal(record.rounds[1]!.verification.verified, true);
});

test('CEGAR preset 3 (3-file wrapper + required query param): repairs cross-module dataflow and outbound request contract', async () => {
  const preset = CEGAR_PRESETS.find((p) => p.id === 'preset-multi-file-wrapper')!;
  const record = await runCegarMigration(preset.request);

  assert.equal(record.callerImpactStatus, 'regression-repaired-verified');
  assert.equal(record.patchStatus, 'verified');
  assert.equal(record.rounds.length, 1);
  assert.equal(record.rounds[0]!.verification.requestContractPassed, true);
  assert.equal(record.finalPatches.length, 2);
});

test('CEGAR preset 4 (unused breaking control): proves static breaking changes unreachable with 0 patches while preserving blocked releaseGate', async () => {
  const preset = CEGAR_PRESETS.find((p) => p.id === 'preset-unused-breaking-control')!;
  const record = await runCegarMigration(preset.request);

  assert.equal(record.releaseGate, 'blocked');
  assert.equal(record.callerImpactStatus, 'unreachable-breaking-safe');
  assert.equal(record.patchStatus, 'not-needed');
  assert.equal(record.rounds.length, 0);
  assert.equal(record.finalPatches.length, 0);
  assert.ok(record.dataflow.reachability.unreachableBreakingChangeIds.length >= 1);
});

test('CEGAR LLM mode & REST router: 2-round counterexample-guided LLM loop + HTTP API persistence & Markdown export', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cg-cegar-api-'));
  try {
    const preset = CEGAR_PRESETS.find((p) => p.id === 'preset-nested-nullable')!;
    let llmCallSeq = 0;

    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      llmCallSeq++;
      const reqBody = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string }>;
      };
      const userPayload = JSON.parse(reqBody.messages[1]!.content) as {
        round: number;
        previousRoundCounterexamples: Array<{ id: string; kind: string }>;
      };

      // Round 1 LLM makes naive structural migration without null guard; Round 2 reads WIT-NULL counterexample and adds `?? ''`
      const patchedContent =
        userPayload.round === 1
          ? [
              'export function formatReceiptHeader(shop: string): string { return shop; }',
              'export function computeLoyaltyTier(points: number): string { return String(points); }',
              'export async function loadOrderBadge(orderId: string): Promise<string> {',
              '  const response = await fetch(`https://api.contractguard.local/orders/${orderId}`);',
              '  const order = await response.json();',
              '  const reviewerTag = order.reviewer.name.toUpperCase();',
              '  const amountUsd = Number(order.pricing.total).toFixed(2);',
              '  return `${order.id}:${reviewerTag}:$${amountUsd}`;',
              '}',
              '',
            ].join('\n')
          : [
              'export function formatReceiptHeader(shop: string): string { return shop; }',
              'export function computeLoyaltyTier(points: number): string { return String(points); }',
              'export async function loadOrderBadge(orderId: string): Promise<string> {',
              '  const response = await fetch(`https://api.contractguard.local/orders/${orderId}`);',
              '  const order = await response.json();',
              "  const reviewerTag = (order?.reviewer?.name ?? '').toUpperCase();",
              '  const amountUsd = Number(order.pricing.total).toFixed(2);',
              '  return `${order.id}:${reviewerTag}:$${amountUsd}`;',
              '}',
              '',
            ].join('\n');

      const proposal = {
        actionSummary: userPayload.round === 1 ? 'LLM 第 1 轮迁移嵌套字段' : 'LLM 第 2 轮依据 WIT-NULL 反例补齐空值保护',
        citedHypothesisIds: [],
        citedCounterexampleIds: userPayload.previousRoundCounterexamples.map((c) => c.id),
        edits: [{ file: 'src/order-card.ts', patchedContent, rationale: `Round ${userPayload.round}` }],
      };

      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(proposal) } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const app = createApp({
      dataDirectory: tempDir,
      serveWeb: false,
      aiConfig: { enabled: true, apiKey: 'sk-test-mock', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
      aiFetch: mockFetch,
    });

    const statusRes = await request(app).get('/api/cegar/status').expect(200);
    assert.equal(statusRes.body.llm.available, true);

    const presetsRes = await request(app).get('/api/cegar/presets').expect(200);
    assert.equal(presetsRes.body.presets.length, 4);

    const runRes = await request(app)
      .post('/api/cegar/runs')
      .send({ ...preset.request, mode: 'llm' })
      .expect(201);

    assert.equal(llmCallSeq, 2);
    assert.equal(runRes.body.patchStatus, 'verified');
    assert.equal(runRes.body.rounds.length, 2);
    assert.equal(runRes.body.rounds[0].proposer, 'llm-agent');
    assert.equal(runRes.body.rounds[0].verification.verified, false);
    assert.equal(runRes.body.rounds[1].verification.verified, true);

    const fetched = await request(app).get(`/api/cegar/runs/${runRes.body.id}`).expect(200);
    assert.equal(fetched.body.id, runRes.body.id);

    const reportMd = await request(app)
      .get(`/api/cegar/runs/${runRes.body.id}/report?format=markdown`)
      .expect(200);
    assert.match(reportMd.text, /CEGAR Refinement Trajectory/);
    assert.match(reportMd.text, /Round 2 \(llm-agent\) — VERIFIED/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
