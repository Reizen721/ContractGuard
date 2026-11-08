import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyCegarWorkspace } from '../dist/index.js';

const baseline = {
  openapi: '3.1.0',
  info: { title: 'Orders', version: '1.0.0' },
  paths: {
    '/orders/current': {
      get: {
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['customerName'],
                  properties: { customerName: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  },
};

const candidate = {
  openapi: '3.1.0',
  info: { title: 'Orders', version: '2.0.0' },
  paths: {
    '/orders/current': {
      get: {
        parameters: [
          { name: 'apiVersion', in: 'query', required: true, schema: { type: 'string', enum: ['2026-11'] } },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['customer'],
                  properties: {
                    customer: {
                      type: 'object',
                      required: ['displayName'],
                      properties: {
                        displayName: { type: ['string', 'null'] },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const callerFiles = [
  {
    path: 'src/orders.ts',
    content: `
export async function getOrderLabel(): Promise<string> {
  const res = await fetch('/orders/current');
  const order = await res.json();
  return order.customerName.toUpperCase();
}
`.trim(),
  },
];

const testFiles = [
  {
    path: 'test/orders.test.ts',
    content: `
import assert from 'node:assert/strict';
import test from 'node:test';
import { getOrderLabel } from '../src/orders.ts';

test('formats current order customer label', async () => {
  assert.equal(await getOrderLabel(), 'ALICE');
});
`.trim(),
  },
];

test('sandbox catches both missing required query param and adversarial null witness crash before certifying refined patch', async () => {
  // Round 1 naive patch: fixes structural path to customer.displayName, forgets query param & null guard
  const round1 = await verifyCegarWorkspace(
    {
      baseline,
      candidate,
      callerFiles,
      testFiles,
      seedBaselineResponses: { 'GET /orders/current': { body: { customerName: 'Alice' } } },
    },
    [
      {
        path: 'src/orders.ts',
        content: `
export async function getOrderLabel(): Promise<string> {
  const res = await fetch('/orders/current');
  const order = await res.json();
  return order.customer.displayName.toUpperCase();
}
`.trim(),
      },
    ],
  );

  // Nominal test passes ('ALICE'), BUT verified MUST be false due to request-contract + adversarial-witness-crash!
  assert.equal(round1.candidateRun?.passed, true);
  assert.equal(round1.verified, false);
  assert.ok(round1.counterexamples.some((c) => c.kind === 'request-contract-violation'));
  assert.ok(round1.counterexamples.some((c) => c.kind === 'adversarial-witness-crash'));

  // Round 2 refined patch: adds ?apiVersion=2026-11 and null-coalescing guard
  const round2 = await verifyCegarWorkspace(
    {
      baseline,
      candidate,
      callerFiles,
      testFiles,
      seedBaselineResponses: { 'GET /orders/current': { body: { customerName: 'Alice' } } },
    },
    [
      {
        path: 'src/orders.ts',
        content: `
export async function getOrderLabel(): Promise<string> {
  const res = await fetch('/orders/current?apiVersion=2026-11');
  const order = await res.json();
  return (order.customer?.displayName ?? 'GUEST').toUpperCase();
}
`.trim(),
      },
    ],
  );

  assert.equal(round2.verified, true, JSON.stringify(round2.counterexamples));
  assert.equal(round2.counterexamples.length, 0);
  assert.ok(round2.adversarialResults.length >= 1 && round2.adversarialResults.every((r) => r.passed));
});
