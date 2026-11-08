/**
 * ContractBench: 24-Case Multi-Category OpenAPI Evolution & Caller Self-Healing Benchmark
 *
 * Categories (4 cases each = 24 cases total):
 *   1. RENAME          (CB-01 .. CB-04, includes 2 Unreachable-Breaking Control Cases CB-03 & CB-04)
 *   2. STRUCTURAL      (CB-05 .. CB-08, Nesting, Flattening, Envelope Wrap, 3-File Wrapper Chain)
 *   3. TYPE_SHIFT      (CB-09 .. CB-12, Cents->Decimal, Epoch->ISO, Number->String Math, Boolean->Enum)
 *   4. NULLABILITY     (CB-13 .. CB-16, Nested Null, Newly Optional, Nullable Number, Relaxed Empty Array)
 *   5. ENUM_EXT        (CB-17 .. CB-20, Switch Throw, Dictionary Lookup, Numeric SLA Switch, 2-File Status)
 *   6. REQUEST_TIGHTEN (CB-21 .. CB-24, Required Query, Renamed Bounded Query, Required Header, POST Body Rename)
 */

function makeGetSpec(title, version, route, responseSchema, extraParams = []) {
  return {
    openapi: '3.0.3',
    info: { title, version },
    paths: {
      [route]: {
        get: {
          parameters: [
            ...(route.includes('{id}')
              ? [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
              : []),
            ...extraParams,
          ],
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: responseSchema } },
            },
          },
        },
      },
    },
  };
}

const UNRELATED_HELPERS = [
  'export function formatAuditStamp(actor: string, seq: number): string {',
  '  const normalized = actor.trim().toLowerCase() || "system";',
  '  return `audit:${normalized}#${String(seq).padStart(4, "0")}`;',
  '}',
  '',
  'export function clampRetryDelayMs(attempt: number): number {',
  '  return Math.min(8000, Math.max(100, Math.pow(2, attempt) * 100));',
  '}',
  '',
].join('\n');

export const CONTRACTBENCH_CASES = [
  // =========================================================================
  // CATEGORY 1: RENAME & REACHABILITY CONTROLS (CB-01 .. CB-04)
  // =========================================================================
  {
    id: 'CB-01',
    category: 'RENAME',
    name: 'Direct property rename with TypeScript DTO interface',
    isUnreachableControl: false,
    baseline: makeGetSpec('CRM API', '1.0.0', '/customers/{id}', {
      type: 'object',
      required: ['id', 'customerEmail', 'tier'],
      properties: {
        id: { type: 'string' },
        customerEmail: { type: 'string' },
        tier: { type: 'string' },
      },
    }),
    candidate: makeGetSpec('CRM API', '2.0.0', '/customers/{id}', {
      type: 'object',
      required: ['id', 'contactEmail', 'tier'],
      properties: {
        id: { type: 'string' },
        contactEmail: { type: 'string' },
        tier: { type: 'string' },
      },
    }),
    seedBaselineResponses: {
      'GET /customers/{id}': {
        status: 200,
        body: { id: 'CUS-1', customerEmail: 'lin@hkust.edu.hk', tier: 'PRO' },
      },
    },
    callerFiles: [
      {
        path: 'src/customer-view.ts',
        content: [
          UNRELATED_HELPERS,
          'interface CustomerRecord {',
          '  id: string;',
          '  customerEmail: string;',
          '  tier: string;',
          '}',
          '',
          'export async function loadCustomerContact(id: string): Promise<string> {',
          '  const res = await fetch(`https://api.contractguard.local/customers/${id}`);',
          '  const data: CustomerRecord = await res.json();',
          '  return `${data.id}<${data.customerEmail}>[${data.tier}]`;',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/customer-view.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { loadCustomerContact } from '../src/customer-view.ts';",
          "test('CB-01 contact line', async () => {",
          "  assert.equal(await loadCustomerContact('CUS-1'), 'CUS-1<lin@hkust.edu.hk>[PRO]');",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/customer-view.ts', exportName: 'loadCustomerContact', args: ['CUS-1'] }],
  },

  {
    id: 'CB-02',
    category: 'RENAME',
    name: 'Object destructuring binding rename',
    isUnreachableControl: false,
    baseline: makeGetSpec('Billing API', '1.0.0', '/invoices/{id}', {
      type: 'object',
      required: ['id', 'invoiceCode', 'currency'],
      properties: {
        id: { type: 'string' },
        invoiceCode: { type: 'string' },
        currency: { type: 'string' },
      },
    }),
    candidate: makeGetSpec('Billing API', '2.0.0', '/invoices/{id}', {
      type: 'object',
      required: ['id', 'referenceCode', 'currency'],
      properties: {
        id: { type: 'string' },
        referenceCode: { type: 'string' },
        currency: { type: 'string' },
      },
    }),
    seedBaselineResponses: {
      'GET /invoices/{id}': {
        status: 200,
        body: { id: 'INV-8', invoiceCode: 'HK-2026-08', currency: 'HKD' },
      },
    },
    callerFiles: [
      {
        path: 'src/invoice-chip.ts',
        content: [
          UNRELATED_HELPERS,
          'export async function readInvoiceRef(id: string): Promise<string> {',
          '  const res = await fetch(`https://api.contractguard.local/invoices/${id}`);',
          '  const { invoiceCode, currency } = await res.json();',
          '  return `${invoiceCode}:${currency}`;',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/invoice-chip.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { readInvoiceRef } from '../src/invoice-chip.ts';",
          "test('CB-02 destructured invoice ref', async () => {",
          "  assert.equal(await readInvoiceRef('INV-8'), 'HK-2026-08:HKD');",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/invoice-chip.ts', exportName: 'readInvoiceRef', args: ['INV-8'] }],
  },

  {
    id: 'CB-03',
    category: 'RENAME',
    name: 'Control #1: Unreachable removed response fields (single-file)',
    isUnreachableControl: true,
    baseline: makeGetSpec('Accounts API', '1.0.0', '/accounts/{id}', {
      type: 'object',
      required: ['id', 'companyName', 'legacyFaxNumber', 'internalTaxCode'],
      properties: {
        id: { type: 'string' },
        companyName: { type: 'string' },
        legacyFaxNumber: { type: 'string' },
        internalTaxCode: { type: 'string' },
      },
    }),
    candidate: makeGetSpec('Accounts API', '2.0.0', '/accounts/{id}', {
      type: 'object',
      required: ['id', 'companyName'],
      properties: {
        id: { type: 'string' },
        companyName: { type: 'string' },
      },
    }),
    seedBaselineResponses: {
      'GET /accounts/{id}': {
        status: 200,
        body: { id: 'ACC-42', companyName: 'Clearwater Labs', legacyFaxNumber: '+852-000', internalTaxCode: 'T-9' },
      },
    },
    callerFiles: [
      {
        path: 'src/account-card.ts',
        content: [
          UNRELATED_HELPERS,
          'export async function loadAccountTitle(id: string): Promise<string> {',
          '  const res = await fetch(`https://api.contractguard.local/accounts/${id}`);',
          '  const acc = await res.json();',
          '  return `${acc.id} · ${acc.companyName}`;',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/account-card.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { loadAccountTitle } from '../src/account-card.ts';",
          "test('CB-03 stable fields unaffected', async () => {",
          "  assert.equal(await loadAccountTitle('ACC-42'), 'ACC-42 · Clearwater Labs');",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/account-card.ts', exportName: 'loadAccountTitle', args: ['ACC-42'] }],
  },

  {
    id: 'CB-04',
    category: 'RENAME',
    name: 'Control #2: Unreachable removed field across 2-file wrapper',
    isUnreachableControl: true,
    baseline: makeGetSpec('Projects API', '1.0.0', '/projects/{id}', {
      type: 'object',
      required: ['id', 'projectName', 'deprecatedSvnMirror'],
      properties: {
        id: { type: 'string' },
        projectName: { type: 'string' },
        deprecatedSvnMirror: { type: 'string' },
      },
    }),
    candidate: makeGetSpec('Projects API', '2.0.0', '/projects/{id}', {
      type: 'object',
      required: ['id', 'projectName'],
      properties: {
        id: { type: 'string' },
        projectName: { type: 'string' },
      },
    }),
    seedBaselineResponses: {
      'GET /projects/{id}': {
        status: 200,
        body: { id: 'PRJ-3', projectName: 'NeuroSymbolic-CEGAR', deprecatedSvnMirror: 'svn://old' },
      },
    },
    callerFiles: [
      {
        path: 'src/api.ts',
        content: [
          'export const apiClient = {',
          '  async get(url: string) {',
          '    const r = await fetch(url);',
          '    return await r.json();',
          '  },',
          '};',
          '',
        ].join('\n'),
      },
      {
        path: 'src/project-header.ts',
        content: [
          "import { apiClient } from './api.ts';",
          UNRELATED_HELPERS,
          'export async function loadProjectHeader(id: string): Promise<string> {',
          '  const p = await apiClient.get(`https://api.contractguard.local/projects/${id}`);',
          '  return `[${p.id}] ${p.projectName}`;',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/project-header.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { loadProjectHeader } from '../src/project-header.ts';",
          "test('CB-04 cross-file unreachable control', async () => {",
          "  assert.equal(await loadProjectHeader('PRJ-3'), '[PRJ-3] NeuroSymbolic-CEGAR');",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/project-header.ts', exportName: 'loadProjectHeader', args: ['PRJ-3'] }],
  },

  // =========================================================================
  // CATEGORY 2: STRUCTURAL (CB-05 .. CB-08)
  // =========================================================================
  {
    id: 'CB-05',
    category: 'STRUCTURAL',
    name: 'Property nesting (postalCode -> location.postalCode)',
    isUnreachableControl: false,
    baseline: makeGetSpec('Store API', '1.0.0', '/stores/{id}', {
      type: 'object',
      required: ['id', 'postalCode'],
      properties: {
        id: { type: 'string' },
        postalCode: { type: 'string' },
      },
    }),
    candidate: makeGetSpec('Store API', '2.0.0', '/stores/{id}', {
      type: 'object',
      required: ['id', 'location'],
      properties: {
        id: { type: 'string' },
        location: {
          type: 'object',
          required: ['postalCode'],
          properties: { postalCode: { type: 'string' } },
        },
      },
    }),
    seedBaselineResponses: {
      'GET /stores/{id}': { status: 200, body: { id: 'ST-1', postalCode: '999077' } },
    },
    callerFiles: [
      {
        path: 'src/store-locator.ts',
        content: [
          UNRELATED_HELPERS,
          'export async function getStoreZip(id: string): Promise<string> {',
          '  const res = await fetch(`https://api.contractguard.local/stores/${id}`);',
          '  const store = await res.json();',
          '  return `${store.id}@${store.postalCode}`;',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/store-locator.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { getStoreZip } from '../src/store-locator.ts';",
          "test('CB-05 nested postalCode', async () => {",
          "  assert.equal(await getStoreZip('ST-1'), 'ST-1@999077');",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/store-locator.ts', exportName: 'getStoreZip', args: ['ST-1'] }],
  },

  {
    id: 'CB-06',
    category: 'STRUCTURAL',
    name: 'Property flattening (author.handle -> authorHandle)',
    isUnreachableControl: false,
    baseline: makeGetSpec('Blog API', '1.0.0', '/articles/{id}', {
      type: 'object',
      required: ['id', 'author'],
      properties: {
        id: { type: 'string' },
        author: {
          type: 'object',
          required: ['handle'],
          properties: { handle: { type: 'string' } },
        },
      },
    }),
    candidate: makeGetSpec('Blog API', '2.0.0', '/articles/{id}', {
      type: 'object',
      required: ['id', 'authorHandle'],
      properties: {
        id: { type: 'string' },
        authorHandle: { type: 'string' },
      },
    }),
    seedBaselineResponses: {
      'GET /articles/{id}': { status: 200, body: { id: 'ART-5', author: { handle: 'dijkstra' } } },
    },
    callerFiles: [
      {
        path: 'src/article-byline.ts',
        content: [
          UNRELATED_HELPERS,
          'export async function loadByline(id: string): Promise<string> {',
          '  const res = await fetch(`https://api.contractguard.local/articles/${id}`);',
          '  const article = await res.json();',
          '  return `@${article.author.handle}`;',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/article-byline.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { loadByline } from '../src/article-byline.ts';",
          "test('CB-06 flattened authorHandle', async () => {",
          "  assert.equal(await loadByline('ART-5'), '@dijkstra');",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/article-byline.ts', exportName: 'loadByline', args: ['ART-5'] }],
  },

  {
    id: 'CB-07',
    category: 'STRUCTURAL',
    name: 'Pagination envelope wrap (Order[] -> { items: Order[], total })',
    isUnreachableControl: false,
    baseline: makeGetSpec('Catalog API', '1.0.0', '/skus', {
      type: 'array',
      items: {
        type: 'object',
        required: ['skuCode'],
        properties: { skuCode: { type: 'string' } },
      },
    }),
    candidate: makeGetSpec('Catalog API', '2.0.0', '/skus', {
      type: 'object',
      required: ['items', 'total'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['skuCode'],
            properties: { skuCode: { type: 'string' } },
          },
        },
        total: { type: 'integer' },
      },
    }),
    seedBaselineResponses: {
      'GET /skus': { status: 200, body: [{ skuCode: 'GPU-H100' }, { skuCode: 'TPU-V5' }] },
    },
    callerFiles: [
      {
        path: 'src/sku-list.ts',
        content: [
          UNRELATED_HELPERS,
          'export async function listSkuCodes(): Promise<string> {',
          '  const res = await fetch("https://api.contractguard.local/skus");',
          '  const list = await res.json();',
          '  return list.map((entry: any) => entry.skuCode).join(",");',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/sku-list.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { listSkuCodes } from '../src/sku-list.ts';",
          "test('CB-07 unwraps pagination envelope', async () => {",
          "  assert.equal(await listSkuCodes(), 'GPU-H100,TPU-V5');",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/sku-list.ts', exportName: 'listSkuCodes', args: [] }],
  },

  {
    id: 'CB-08',
    category: 'STRUCTURAL',
    name: '3-file inter-procedural wrapper chain (userName -> profile.displayName)',
    isUnreachableControl: false,
    baseline: makeGetSpec('Directory API', '1.0.0', '/members/{id}', {
      type: 'object',
      required: ['id', 'userName', 'department'],
      properties: {
        id: { type: 'string' },
        userName: { type: 'string' },
        department: { type: 'string' },
      },
    }),
    candidate: makeGetSpec('Directory API', '2.0.0', '/members/{id}', {
      type: 'object',
      required: ['id', 'profile', 'department'],
      properties: {
        id: { type: 'string' },
        profile: {
          type: 'object',
          required: ['displayName'],
          properties: { displayName: { type: 'string' } },
        },
        department: { type: 'string' },
      },
    }),
    seedBaselineResponses: {
      'GET /members/{id}': { status: 200, body: { id: 'M-1', userName: 'Barbara Liskov', department: 'Systems' } },
    },
    callerFiles: [
      {
        path: 'src/http.ts',
        content: [
          'export const http = {',
          '  async get(url: string) {',
          '    const r = await fetch(url);',
          '    return await r.json();',
          '  },',
          '};',
          '',
        ].join('\n'),
      },
      {
        path: 'src/member-repo.ts',
        content: [
          "import { http } from './http.ts';",
          'export async function fetchMember(id: string) {',
          '  return await http.get(`https://api.contractguard.local/members/${id}`);',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/member-card.ts',
        content: [
          "import { fetchMember } from './member-repo.ts';",
          UNRELATED_HELPERS,
          'export async function formatMember(id: string): Promise<string> {',
          '  const m = await fetchMember(id);',
          '  return `${m.userName} [${m.department}]`;',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/member-card.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { formatMember } from '../src/member-card.ts';",
          "test('CB-08 3-file wrapper structural migration', async () => {",
          "  assert.equal(await formatMember('M-1'), 'Barbara Liskov [Systems]');",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/member-card.ts', exportName: 'formatMember', args: ['M-1'] }],
  },

  // =========================================================================
  // CATEGORY 3: TYPE_SHIFT (CB-09 .. CB-12)
  // =========================================================================
  {
    id: 'CB-09',
    category: 'TYPE_SHIFT',
    name: 'Monetary integer cents -> decimal string (amountCents -> amountDecimal)',
    isUnreachableControl: false,
    baseline: makeGetSpec('Pay API', '1.0.0', '/payments/{id}', {
      type: 'object',
      required: ['id', 'amountCents'],
      properties: {
        id: { type: 'string' },
        amountCents: { type: 'integer' },
      },
    }),
    candidate: makeGetSpec('Pay API', '2.0.0', '/payments/{id}', {
      type: 'object',
      required: ['id', 'amountDecimal'],
      properties: {
        id: { type: 'string' },
        amountDecimal: { type: 'string' },
      },
    }),
    seedBaselineResponses: {
      'GET /payments/{id}': { status: 200, body: { id: 'PAY-1', amountCents: 1995 } },
    },
    callerFiles: [
      {
        path: 'src/payment-summary.ts',
        content: [
          UNRELATED_HELPERS,
          'export async function renderPaymentUsd(id: string): Promise<string> {',
          '  const res = await fetch(`https://api.contractguard.local/payments/${id}`);',
          '  const pay = await res.json();',
          '  return `$${(pay.amountCents / 100).toFixed(2)}`;',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/payment-summary.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { renderPaymentUsd } from '../src/payment-summary.ts';",
          "test('CB-09 cents to decimal string', async () => {",
          "  assert.equal(await renderPaymentUsd('PAY-1'), '$19.95');",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/payment-summary.ts', exportName: 'renderPaymentUsd', args: ['PAY-1'] }],
  },

  {
    id: 'CB-10',
    category: 'TYPE_SHIFT',
    name: 'Unix epoch seconds -> ISO-8601 date-time string',
    isUnreachableControl: false,
    baseline: makeGetSpec('Audit API', '1.0.0', '/events/{id}', {
      type: 'object',
      required: ['id', 'createdAt'],
      properties: {
        id: { type: 'string' },
        createdAt: { type: 'integer' },
      },
    }),
    candidate: makeGetSpec('Audit API', '2.0.0', '/events/{id}', {
      type: 'object',
      required: ['id', 'createdAt'],
      properties: {
        id: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    }),
    seedBaselineResponses: {
      'GET /events/{id}': { status: 200, body: { id: 'EV-1', createdAt: 1767225600 } },
    },
    callerFiles: [
      {
        path: 'src/event-date.ts',
        content: [
          UNRELATED_HELPERS,
          'export async function getEventDay(id: string): Promise<string> {',
          '  const res = await fetch(`https://api.contractguard.local/events/${id}`);',
          '  const ev = await res.json();',
          '  return new Date(ev.createdAt * 1000).toISOString().slice(0, 10);',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/event-date.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { getEventDay } from '../src/event-date.ts';",
          "test('CB-10 epoch to ISO string', async () => {",
          "  assert.equal(await getEventDay('EV-1'), '2026-01-01');",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/event-date.ts', exportName: 'getEventDay', args: ['EV-1'] }],
  },

  {
    id: 'CB-11',
    category: 'TYPE_SHIFT',
    name: 'Numeric latency -> string numeric representation in arithmetic expression',
    isUnreachableControl: false,
    baseline: makeGetSpec('Telemetry API', '1.0.0', '/metrics/{id}', {
      type: 'object',
      required: ['id', 'latencyMs'],
      properties: {
        id: { type: 'string' },
        latencyMs: { type: 'integer' },
      },
    }),
    candidate: makeGetSpec('Telemetry API', '2.0.0', '/metrics/{id}', {
      type: 'object',
      required: ['id', 'latencyMs'],
      properties: {
        id: { type: 'string' },
        latencyMs: { type: 'string' },
      },
    }),
    seedBaselineResponses: {
      'GET /metrics/{id}': { status: 200, body: { id: 'M-9', latencyMs: 45 } },
    },
    callerFiles: [
      {
        path: 'src/sla-budget.ts',
        content: [
          UNRELATED_HELPERS,
          'export async function computeBufferedLatency(id: string): Promise<number> {',
          '  const res = await fetch(`https://api.contractguard.local/metrics/${id}`);',
          '  const m = await res.json();',
          '  return m.latencyMs + 15;',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/sla-budget.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { computeBufferedLatency } from '../src/sla-budget.ts';",
          "test('CB-11 prevents string concatenation bug', async () => {",
          "  assert.equal(await computeBufferedLatency('M-9'), 60);",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/sla-budget.ts', exportName: 'computeBufferedLatency', args: ['M-9'] }],
  },

  {
    id: 'CB-12',
    category: 'TYPE_SHIFT',
    name: 'Boolean flag -> lifecycle enum (isArchived: boolean -> archiveState: ACTIVE|ARCHIVED)',
    isUnreachableControl: false,
    baseline: makeGetSpec('Repo API', '1.0.0', '/repos/{id}', {
      type: 'object',
      required: ['id', 'isArchived'],
      properties: {
        id: { type: 'string' },
        isArchived: { type: 'boolean' },
      },
    }),
    candidate: makeGetSpec('Repo API', '2.0.0', '/repos/{id}', {
      type: 'object',
      required: ['id', 'archiveState'],
      properties: {
        id: { type: 'string' },
        archiveState: { type: 'string', enum: ['ACTIVE', 'ARCHIVED'] },
      },
    }),
    seedBaselineResponses: {
      'GET /repos/{id}': { status: 200, body: { id: 'R-2', isArchived: true } },
    },
    callerFiles: [
      {
        path: 'src/repo-badge.ts',
        content: [
          UNRELATED_HELPERS,
          'export async function getRepoAccessMode(id: string): Promise<string> {',
          '  const res = await fetch(`https://api.contractguard.local/repos/${id}`);',
          '  const repo = await res.json();',
          '  return repo.isArchived ? "READ_ONLY" : "WRITABLE";',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/repo-badge.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { getRepoAccessMode } from '../src/repo-badge.ts';",
          "test('CB-12 boolean to enum', async () => {",
          "  assert.equal(await getRepoAccessMode('R-2'), 'READ_ONLY');",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/repo-badge.ts', exportName: 'getRepoAccessMode', args: ['R-2'] }],
  },

  // =========================================================================
  // CATEGORY 4: NULLABILITY & BOUNDARY RELAXATION (CB-13 .. CB-16) — 2-Round CEGAR!
  // =========================================================================
  {
    id: 'CB-13',
    category: 'NULLABILITY',
    name: 'Structural nest + nullable container (reviewerName -> reviewer?.name | null)',
    isUnreachableControl: false,
    baseline: makeGetSpec('Orders API', '1.0.0', '/orders/{id}', {
      type: 'object',
      required: ['id', 'reviewerName'],
      properties: {
        id: { type: 'string' },
        reviewerName: { type: 'string' },
      },
    }),
    candidate: makeGetSpec('Orders API', '2.0.0', '/orders/{id}', {
      type: 'object',
      required: ['id', 'reviewer'],
      properties: {
        id: { type: 'string' },
        reviewer: {
          type: 'object',
          nullable: true,
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
      },
    }),
    seedBaselineResponses: {
      'GET /orders/{id}': { status: 200, body: { id: 'ORD-1', reviewerName: 'Ada Lovelace' } },
    },
    callerFiles: [
      {
        path: 'src/order-reviewer.ts',
        content: [
          UNRELATED_HELPERS,
          'export async function formatOrderReviewer(id: string): Promise<string> {',
          '  const res = await fetch(`https://api.contractguard.local/orders/${id}`);',
          '  const order = await res.json();',
          '  return `${order.id}:${order.reviewerName.toUpperCase()}`;',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/order-reviewer.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { formatOrderReviewer } from '../src/order-reviewer.ts';",
          "test('CB-13 nominal order reviewer', async () => {",
          "  assert.equal(await formatOrderReviewer('ORD-1'), 'ORD-1:ADA LOVELACE');",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/order-reviewer.ts', exportName: 'formatOrderReviewer', args: ['ORD-1'] }],
  },

  {
    id: 'CB-14',
    category: 'NULLABILITY',
    name: 'Required string -> optional omitted property (couponCode WIT-OPT)',
    isUnreachableControl: false,
    baseline: makeGetSpec('Cart API', '1.0.0', '/carts/{id}', {
      type: 'object',
      required: ['id', 'couponCode'],
      properties: {
        id: { type: 'string' },
        couponCode: { type: 'string' },
      },
    }),
    candidate: makeGetSpec('Cart API', '2.0.0', '/carts/{id}', {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        couponCode: { type: 'string' },
      },
    }),
    seedBaselineResponses: {
      'GET /carts/{id}': { status: 200, body: { id: 'CRT-2', couponCode: 'HKUST26' } },
    },
    callerFiles: [
      {
        path: 'src/cart-coupon.ts',
        content: [
          UNRELATED_HELPERS,
          'export async function normalizeCoupon(id: string): Promise<string> {',
          '  const res = await fetch(`https://api.contractguard.local/carts/${id}`);',
          '  const cart = await res.json();',
          '  return cart.couponCode.trim().toLowerCase();',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/cart-coupon.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { normalizeCoupon } from '../src/cart-coupon.ts';",
          "test('CB-14 nominal coupon present', async () => {",
          "  assert.equal(await normalizeCoupon('CRT-2'), 'hkust26');",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/cart-coupon.ts', exportName: 'normalizeCoupon', args: ['CRT-2'] }],
  },

  {
    id: 'CB-15',
    category: 'NULLABILITY',
    name: 'Field rename + newly nullable number calling .toFixed(2) (WIT-NULL)',
    isUnreachableControl: false,
    baseline: makeGetSpec('Quotes API', '1.0.0', '/quotes/{id}', {
      type: 'object',
      required: ['id', 'discountRate'],
      properties: {
        id: { type: 'string' },
        discountRate: { type: 'number' },
      },
    }),
    candidate: makeGetSpec('Quotes API', '2.0.0', '/quotes/{id}', {
      type: 'object',
      required: ['id', 'appliedDiscountRate'],
      properties: {
        id: { type: 'string' },
        appliedDiscountRate: { type: 'number', nullable: true },
      },
    }),
    seedBaselineResponses: {
      'GET /quotes/{id}': { status: 200, body: { id: 'Q-7', discountRate: 12.5 } },
    },
    callerFiles: [
      {
        path: 'src/quote-discount.ts',
        content: [
          UNRELATED_HELPERS,
          'export async function formatDiscountPct(id: string): Promise<string> {',
          '  const res = await fetch(`https://api.contractguard.local/quotes/${id}`);',
          '  const quote = await res.json();',
          '  return `${quote.discountRate.toFixed(1)}%`;',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/quote-discount.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { formatDiscountPct } from '../src/quote-discount.ts';",
          "test('CB-15 nominal discount rate', async () => {",
          "  assert.equal(await formatDiscountPct('Q-7'), '12.5%');",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/quote-discount.ts', exportName: 'formatDiscountPct', args: ['Q-7'] }],
  },

  {
    id: 'CB-16',
    category: 'NULLABILITY',
    name: 'Array minItems relaxation (minItems: 1 -> 0) indexing head element [0] (WIT-EMPTY)',
    isUnreachableControl: false,
    baseline: makeGetSpec('Tickets API', '1.0.0', '/tickets/{id}', {
      type: 'object',
      required: ['id', 'tags'],
      properties: {
        id: { type: 'string' },
        tags: { type: 'array', minItems: 1, items: { type: 'string' } },
      },
    }),
    candidate: makeGetSpec('Tickets API', '2.0.0', '/tickets/{id}', {
      type: 'object',
      required: ['id', 'tags'],
      properties: {
        id: { type: 'string' },
        tags: { type: 'array', minItems: 0, items: { type: 'string' } },
      },
    }),
    seedBaselineResponses: {
      'GET /tickets/{id}': { status: 200, body: { id: 'TKT-4', tags: ['SECURITY'] } },
    },
    callerFiles: [
      {
        path: 'src/ticket-tag.ts',
        content: [
          UNRELATED_HELPERS,
          'export async function primaryTicketTag(id: string): Promise<string> {',
          '  const res = await fetch(`https://api.contractguard.local/tickets/${id}`);',
          '  const ticket = await res.json();',
          '  return ticket.tags[0].toLowerCase();',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/ticket-tag.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { primaryTicketTag } from '../src/ticket-tag.ts';",
          "test('CB-16 nominal primary tag', async () => {",
          "  assert.equal(await primaryTicketTag('TKT-4'), 'security');",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/ticket-tag.ts', exportName: 'primaryTicketTag', args: ['TKT-4'] }],
  },

  // =========================================================================
  // CATEGORY 5: ENUM_EXT (CB-17 .. CB-20) — 2-Round CEGAR via WIT-ENUM!
  // =========================================================================
  {
    id: 'CB-17',
    category: 'ENUM_EXT',
    name: 'Enum rename + new variant crashing exhaustive switch default throw (WIT-ENUM)',
    isUnreachableControl: false,
    baseline: makeGetSpec('Shipping API', '1.0.0', '/shipments/{id}', {
      type: 'object',
      required: ['id', 'state'],
      properties: {
        id: { type: 'string' },
        state: { type: 'string', enum: ['PENDING', 'DISPATCHED', 'DELIVERED'] },
      },
    }),
    candidate: makeGetSpec('Shipping API', '2.0.0', '/shipments/{id}', {
      type: 'object',
      required: ['id', 'state'],
      properties: {
        id: { type: 'string' },
        state: { type: 'string', enum: ['PENDING', 'IN_TRANSIT', 'DELIVERED', 'CUSTOMS_HOLD'] },
      },
    }),
    seedBaselineResponses: {
      'GET /shipments/{id}': { status: 200, body: { id: 'SHP-9', state: 'DISPATCHED' } },
    },
    callerFiles: [
      {
        path: 'src/shipment-state.ts',
        content: [
          UNRELATED_HELPERS,
          'export async function describeShipmentState(id: string): Promise<string> {',
          '  const res = await fetch(`https://api.contractguard.local/shipments/${id}`);',
          '  const s = await res.json();',
          '  switch (s.state) {',
          "    case 'PENDING': return 'WAITING';",
          "    case 'DISPATCHED': return 'MOVING';",
          "    case 'DELIVERED': return 'ARRIVED';",
          "    default: throw new Error(`Unexpected state: ${s.state}`);",
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/shipment-state.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { describeShipmentState } from '../src/shipment-state.ts';",
          "test('CB-17 nominal shipment state', async () => {",
          "  assert.equal(await describeShipmentState('SHP-9'), 'MOVING');",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/shipment-state.ts', exportName: 'describeShipmentState', args: ['SHP-9'] }],
  },

  {
    id: 'CB-18',
    category: 'ENUM_EXT',
    name: 'New payment rail enum variant crashing dictionary lookup .toFixed(2) (WIT-ENUM)',
    isUnreachableControl: false,
    baseline: makeGetSpec('Payouts API', '1.0.0', '/payouts/{id}', {
      type: 'object',
      required: ['id', 'channel'],
      properties: {
        id: { type: 'string' },
        channel: { type: 'string', enum: ['ACH', 'WIRE'] },
      },
    }),
    candidate: makeGetSpec('Payouts API', '2.0.0', '/payouts/{id}', {
      type: 'object',
      required: ['id', 'channel'],
      properties: {
        id: { type: 'string' },
        channel: { type: 'string', enum: ['ACH', 'WIRE', 'FPS_INSTANT'] },
      },
    }),
    seedBaselineResponses: {
      'GET /payouts/{id}': { status: 200, body: { id: 'PO-3', channel: 'ACH' } },
    },
    callerFiles: [
      {
        path: 'src/payout-fee.ts',
        content: [
          UNRELATED_HELPERS,
          'const FEE_RATES: Record<string, number> = { ACH: 0.25, WIRE: 15.0 };',
          '',
          'export async function formatRailFee(id: string): Promise<string> {',
          '  const res = await fetch(`https://api.contractguard.local/payouts/${id}`);',
          '  const payout = await res.json();',
          '  return FEE_RATES[payout.channel].toFixed(2);',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/payout-fee.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { formatRailFee } from '../src/payout-fee.ts';",
          "test('CB-18 nominal ACH rail fee', async () => {",
          "  assert.equal(await formatRailFee('PO-3'), '0.25');",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/payout-fee.ts', exportName: 'formatRailFee', args: ['PO-3'] }],
  },

  {
    id: 'CB-19',
    category: 'ENUM_EXT',
    name: 'Numeric return-type switch with renamed + extended priority enum (TypeChecker fallback 0)',
    isUnreachableControl: false,
    baseline: makeGetSpec('Tasks API', '1.0.0', '/tasks/{id}', {
      type: 'object',
      required: ['id', 'priority'],
      properties: {
        id: { type: 'string' },
        priority: { type: 'string', enum: ['LOW', 'HIGH'] },
      },
    }),
    candidate: makeGetSpec('Tasks API', '2.0.0', '/tasks/{id}', {
      type: 'object',
      required: ['id', 'priority'],
      properties: {
        id: { type: 'string' },
        priority: { type: 'string', enum: ['LOW', 'CRITICAL', 'BACKLOG'] },
      },
    }),
    seedBaselineResponses: {
      'GET /tasks/{id}': { status: 200, body: { id: 'TSK-2', priority: 'HIGH' } },
    },
    callerFiles: [
      {
        path: 'src/task-sla.ts',
        content: [
          UNRELATED_HELPERS,
          'export async function targetResponseHours(id: string): Promise<number> {',
          '  const res = await fetch(`https://api.contractguard.local/tasks/${id}`);',
          '  const task = await res.json();',
          '  switch (task.priority) {',
          "    case 'LOW': return 24;",
          "    case 'HIGH': return 2;",
          "    default: throw new Error(`Unsupported priority ${task.priority}`);",
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/task-sla.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { targetResponseHours } from '../src/task-sla.ts';",
          "test('CB-19 numeric SLA hours', async () => {",
          "  assert.equal(await targetResponseHours('TSK-2'), 2);",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/task-sla.ts', exportName: 'targetResponseHours', args: ['TSK-2'] }],
  },

  {
    id: 'CB-20',
    category: 'ENUM_EXT',
    name: '2-file client wrapper + extended review verdict enum (WIT-ENUM)',
    isUnreachableControl: false,
    baseline: makeGetSpec('Reviews API', '1.0.0', '/reviews/{id}', {
      type: 'object',
      required: ['id', 'verdict'],
      properties: {
        id: { type: 'string' },
        verdict: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
      },
    }),
    candidate: makeGetSpec('Reviews API', '2.0.0', '/reviews/{id}', {
      type: 'object',
      required: ['id', 'verdict'],
      properties: {
        id: { type: 'string' },
        verdict: { type: 'string', enum: ['APPROVED', 'REJECTED', 'NEEDS_WORK'] },
      },
    }),
    seedBaselineResponses: {
      'GET /reviews/{id}': { status: 200, body: { id: 'REV-5', verdict: 'APPROVED' } },
    },
    callerFiles: [
      {
        path: 'src/review-client.ts',
        content: [
          'export const reviewHttp = {',
          '  async get(url: string) {',
          '    const r = await fetch(url);',
          '    return await r.json();',
          '  },',
          '};',
          '',
        ].join('\n'),
      },
      {
        path: 'src/review-label.ts',
        content: [
          "import { reviewHttp } from './review-client.ts';",
          UNRELATED_HELPERS,
          'export async function getReviewBanner(id: string): Promise<string> {',
          '  const rev = await reviewHttp.get(`https://api.contractguard.local/reviews/${id}`);',
          '  switch (rev.verdict) {',
          "    case 'APPROVED': return 'SHIP_IT';",
          "    case 'REJECTED': return 'BLOCKED';",
          "    default: throw new Error(`Unknown verdict: ${rev.verdict}`);",
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/review-label.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { getReviewBanner } from '../src/review-label.ts';",
          "test('CB-20 2-file review verdict', async () => {",
          "  assert.equal(await getReviewBanner('REV-5'), 'SHIP_IT');",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/review-label.ts', exportName: 'getReviewBanner', args: ['REV-5'] }],
  },

  // =========================================================================
  // CATEGORY 6: REQUEST_TIGHTEN (CB-21 .. CB-24) — Outbound Request Contract Gate!
  // =========================================================================
  {
    id: 'CB-21',
    category: 'REQUEST_TIGHTEN',
    name: 'Newly required query parameter (apiVersion=2026-11)',
    isUnreachableControl: false,
    baseline: makeGetSpec('Users API', '1.0.0', '/users/{id}', {
      type: 'object',
      required: ['id', 'handle'],
      properties: { id: { type: 'string' }, handle: { type: 'string' } },
    }),
    candidate: makeGetSpec(
      'Users API',
      '2.0.0',
      '/users/{id}',
      {
        type: 'object',
        required: ['id', 'handle'],
        properties: { id: { type: 'string' }, handle: { type: 'string' } },
      },
      [{ name: 'apiVersion', in: 'query', required: true, schema: { type: 'string', enum: ['2026-11'] } }],
    ),
    seedBaselineResponses: {
      'GET /users/{id}': { status: 200, body: { id: 'U-1', handle: 'hopper' } },
    },
    callerFiles: [
      {
        path: 'src/user-handle.ts',
        content: [
          UNRELATED_HELPERS,
          'export async function fetchUserHandle(id: string): Promise<string> {',
          '  const res = await fetch(`https://api.contractguard.local/users/${id}`);',
          '  const u = await res.json();',
          '  return `@${u.handle}`;',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/user-handle.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { fetchUserHandle } from '../src/user-handle.ts';",
          "test('CB-21 required query param', async () => {",
          "  assert.equal(await fetchUserHandle('U-1'), '@hopper');",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/user-handle.ts', exportName: 'fetchUserHandle', args: ['U-1'] }],
  },

  {
    id: 'CB-22',
    category: 'REQUEST_TIGHTEN',
    name: 'Query parameter rename + maximum bound clamping (limit=50 -> pageSize=20)',
    isUnreachableControl: false,
    baseline: makeGetSpec(
      'Feed API',
      '1.0.0',
      '/feed',
      {
        type: 'object',
        required: ['count'],
        properties: { count: { type: 'integer' } },
      },
      [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', maximum: 100 } }],
    ),
    candidate: makeGetSpec(
      'Feed API',
      '2.0.0',
      '/feed',
      {
        type: 'object',
        required: ['count'],
        properties: { count: { type: 'integer' } },
      },
      [{ name: 'pageSize', in: 'query', required: true, schema: { type: 'integer', maximum: 20 } }],
    ),
    seedBaselineResponses: {
      'GET /feed': { status: 200, body: { count: 12 } },
    },
    callerFiles: [
      {
        path: 'src/feed-loader.ts',
        content: [
          UNRELATED_HELPERS,
          'export async function loadFeedCount(): Promise<number> {',
          '  const res = await fetch("https://api.contractguard.local/feed?limit=50");',
          '  const payload = await res.json();',
          '  return payload.count;',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/feed-loader.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { loadFeedCount } from '../src/feed-loader.ts';",
          "test('CB-22 renamed bounded query param', async () => {",
          '  assert.equal(await loadFeedCount(), 12);',
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/feed-loader.ts', exportName: 'loadFeedCount', args: [] }],
  },

  {
    id: 'CB-23',
    category: 'REQUEST_TIGHTEN',
    name: 'Newly required HTTP request header (x-tenant-region)',
    isUnreachableControl: false,
    baseline: makeGetSpec('Ledger API', '1.0.0', '/ledgers/{id}', {
      type: 'object',
      required: ['id', 'balance'],
      properties: { id: { type: 'string' }, balance: { type: 'number' } },
    }),
    candidate: makeGetSpec(
      'Ledger API',
      '2.0.0',
      '/ledgers/{id}',
      {
        type: 'object',
        required: ['id', 'balance'],
        properties: { id: { type: 'string' }, balance: { type: 'number' } },
      },
      [{ name: 'x-tenant-region', in: 'header', required: true, schema: { type: 'string', enum: ['hk-east'] } }],
    ),
    seedBaselineResponses: {
      'GET /ledgers/{id}': { status: 200, body: { id: 'LDG-1', balance: 500 } },
    },
    callerFiles: [
      {
        path: 'src/ledger-client.ts',
        content: [
          UNRELATED_HELPERS,
          'export async function getLedgerBalance(id: string): Promise<string> {',
          '  const res = await fetch(`https://api.contractguard.local/ledgers/${id}`);',
          '  const ldg = await res.json();',
          '  return `${ldg.id}:${ldg.balance}`;',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/ledger-client.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { getLedgerBalance } from '../src/ledger-client.ts';",
          "test('CB-23 required tenant header', async () => {",
          "  assert.equal(await getLedgerBalance('LDG-1'), 'LDG-1:500');",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/ledger-client.ts', exportName: 'getLedgerBalance', args: ['LDG-1'] }],
  },

  {
    id: 'CB-24',
    category: 'REQUEST_TIGHTEN',
    name: 'POST JSON request body property rename + response property rename',
    isUnreachableControl: false,
    baseline: {
      openapi: '3.0.3',
      info: { title: 'Webhooks API', version: '1.0.0' },
      paths: {
        '/webhooks': {
          post: {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['callbackUrl'],
                    additionalProperties: false,
                    properties: { callbackUrl: { type: 'string' } },
                  },
                },
              },
            },
            responses: {
              '201': {
                description: 'Created',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['hookId'],
                      properties: { hookId: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    candidate: {
      openapi: '3.0.3',
      info: { title: 'Webhooks API', version: '2.0.0' },
      paths: {
        '/webhooks': {
          post: {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['targetEndpoint'],
                    additionalProperties: false,
                    properties: { targetEndpoint: { type: 'string' } },
                  },
                },
              },
            },
            responses: {
              '201': {
                description: 'Created v2',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['subscriptionId'],
                      properties: { subscriptionId: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    seedBaselineResponses: {
      'POST /webhooks': { status: 201, body: { hookId: 'WH-77' } },
    },
    callerFiles: [
      {
        path: 'src/webhook-registrar.ts',
        content: [
          UNRELATED_HELPERS,
          'export async function registerWebhook(endpoint: string): Promise<string> {',
          '  const res = await fetch("https://api.contractguard.local/webhooks", {',
          "    method: 'POST',",
          "    headers: { 'Content-Type': 'application/json' },",
          '    body: JSON.stringify({ callbackUrl: endpoint }),',
          '  });',
          '  const created = await res.json();',
          '  return created.hookId;',
          '}',
          '',
        ].join('\n'),
      },
    ],
    testFiles: [
      {
        path: 'tests/webhook-registrar.test.mjs',
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { registerWebhook } from '../src/webhook-registrar.ts';",
          "test('CB-24 POST request body + response rename', async () => {",
          "  assert.equal(await registerWebhook('https://client.local/hook'), 'WH-77');",
          '});',
          '',
        ].join('\n'),
      },
    ],
    probes: [{ file: 'src/webhook-registrar.ts', exportName: 'registerWebhook', args: ['https://client.local/hook'] }],
  },
];
