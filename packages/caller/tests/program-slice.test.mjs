import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeProgramDataflow, typecheckVirtualFiles } from '../dist/index.js';

const baseline = {
  openapi: '3.1.0',
  info: { title: 'Shop', version: '1.0.0' },
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
                  required: ['customerName', 'legacyFax', 'items'],
                  properties: {
                    customerName: { type: 'string' },
                    legacyFax: { type: 'string' },
                    items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['unitCents'],
                        properties: { unitCents: { type: 'integer' } },
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

const candidate = {
  openapi: '3.1.0',
  info: { title: 'Shop', version: '2.0.0' },
  paths: {
    '/orders/current': {
      get: {
        responses: {
          '200': {
            description: 'OK',
            content: {
              application_json_placeholder: undefined,
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['displayName', 'items'],
                  properties: {
                    displayName: { type: 'string' },
                    items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['priceCents'],
                        properties: { priceCents: { type: 'integer' } },
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
delete candidate.paths['/orders/current'].get.responses['200'].content.application_json_placeholder;

test('inter-procedural TypeChecker dataflow tracks across imported wrappers, destructuring, and array callbacks', () => {
  const files = [
    {
      path: 'src/http-client.ts',
      content: `
export async function fetchCurrentOrder() {
  const res = await fetch('/orders/current');
  return await res.json();
}
export function unrelatedMathHelper(x: number): number {
  return x * 42 + 100;
}
`.trim(),
    },
    {
      path: 'src/order-view.ts',
      content: `
import { fetchCurrentOrder } from './http-client.js';

export async function renderSummary() {
  const order = await fetchCurrentOrder();
  const { customerName } = order;
  const prices = order.items.map((item: any) => item.unitCents);
  return customerName.toUpperCase() + ':' + prices.join(',');
}

export function bigUnrelatedFormatter(lines: string[]): string {
  return lines.map((line) => line.trim()).filter(Boolean).join('\\n');
}
`.trim(),
    },
    {
      path: 'src/unused-module.ts',
      content: `
export function computeShippingTax(amount: number): number {
  return Math.round(amount * 0.08);
}
`.trim(),
    },
  ];

  const report = analyzeProgramDataflow(files, baseline, candidate);
  assert.equal(report.typecheck.clean, true, JSON.stringify(report.typecheck.diagnostics));
  assert.equal(report.callsites.length, 1);
  assert.equal(report.callsites[0].matchedPath, '/orders/current');
  assert.ok(report.callEdges.some((e) => e.fromFile === 'src/order-view.ts' && e.toFile === 'src/http-client.ts'));

  // Tracks both destructured `customerName` and array callback `items[].unitCents`!
  assert.ok(report.fieldUsages.some((u) => u.dotPath === 'customerName' && u.file === 'src/order-view.ts'));
  assert.ok(report.fieldUsages.some((u) => u.dotPath === 'items[].unitCents' && u.file === 'src/order-view.ts'));

  // `legacyFax` was deleted in candidate, which is a static breaking change, but UNUSED in caller AST!
  assert.ok(report.reachability.unreachableBreakingChangeIds.length >= 1);
  assert.ok(report.reachability.reachableBreakingChangeIds.length >= 1);

  // Program slicing drops src/unused-module.ts and unrelated functions, compressing prompt context
  assert.equal(report.metrics.impactedFiles, 2);
  assert.ok(report.metrics.compressionRatio > 0.2);
});

test('typecheckVirtualFiles catches real TypeScript semantic errors cleanly', () => {
  const check = typecheckVirtualFiles([
    {
      path: 'src/bad.ts',
      content: `
interface Order { displayName: string | null }
export function label(order: Order): string {
  return order.displayName.toUpperCase();
}
`,
    },
  ]);
  assert.equal(check.clean, false);
  assert.ok(check.diagnostics.some((d) => d.code === 18047));
});
