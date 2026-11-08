import type { CegarPreset } from './types.js';

export const CEGAR_PRESETS: CegarPreset[] = [
  {
    id: 'preset-nested-nullable',
    label: '订单结构嵌套 + 可空反例精化',
    category: 'STRUCTURAL + NULLABILITY',
    description: '自动推导结构嵌套与分转元，捕获 reviewer: null 空指针并在第 2 轮补齐空值保护。',
    expectedRounds: 2,
    request: {
      title: '订单徽章：结构嵌套 + 分转元 + WIT-NULL 反例精化',
      mode: 'symbolic',
      maxRounds: 4,
      enableAdversarialFuzzing: true,
      baseline: {
        openapi: '3.0.3',
        info: { title: 'Orders API', version: '1.0.0' },
        paths: {
          '/orders/{id}': {
            get: {
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
              responses: {
                '200': {
                  description: 'Order summary',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['id', 'reviewerName', 'totalCents'],
                        properties: {
                          id: { type: 'string' },
                          reviewerName: { type: 'string' },
                          totalCents: { type: 'integer' },
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
      candidate: {
        openapi: '3.0.3',
        info: { title: 'Orders API', version: '2.0.0' },
        paths: {
          '/orders/{id}': {
            get: {
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
              responses: {
                '200': {
                  description: 'Order summary v2',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['id', 'reviewer', 'pricing'],
                        properties: {
                          id: { type: 'string' },
                          reviewer: {
                            type: 'object',
                            nullable: true,
                            required: ['name'],
                            properties: { name: { type: 'string' } },
                          },
                          pricing: {
                            type: 'object',
                            required: ['total'],
                            properties: { total: { type: 'string' } },
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
      seedBaselineResponses: {
        'GET /orders/{id}': {
          status: 200,
          body: { id: 'ORD-101', reviewerName: 'Ada Lovelace', totalCents: 2450 },
        },
      },
      callerFiles: [
        {
          path: 'src/order-card.ts',
          content: [
            'export function formatReceiptHeader(shop: string): string {',
            '  return `[RECEIPT:${shop.trim().toUpperCase()}]`;',
            '}',
            '',
            'export function computeLoyaltyTier(points: number): string {',
            '  if (points >= 1000) return "GOLD";',
            '  if (points >= 300) return "SILVER";',
            '  return "STANDARD";',
            '}',
            '',
            'export async function loadOrderBadge(orderId: string): Promise<string> {',
            '  const response = await fetch(`https://api.contractguard.local/orders/${orderId}`);',
            '  const order = await response.json();',
            '  const reviewerTag = order.reviewerName.toUpperCase();',
            '  const amountUsd = (order.totalCents / 100).toFixed(2);',
            '  return `${order.id}:${reviewerTag}:$${amountUsd}`;',
            '}',
            '',
          ].join('\n'),
        },
      ],
      testFiles: [
        {
          path: 'tests/order-card.test.mjs',
          content: [
            "import test from 'node:test';",
            "import assert from 'node:assert/strict';",
            "import { loadOrderBadge } from '../src/order-card.ts';",
            '',
            "test('formats nominal order badge', async () => {",
            "  const badge = await loadOrderBadge('ORD-101');",
            "  assert.equal(badge, 'ORD-101:ADA LOVELACE:$24.50');",
            '});',
            '',
          ].join('\n'),
        },
      ],
      probes: [{ file: 'src/order-card.ts', exportName: 'loadOrderBadge', args: ['ORD-101'] }],
    },
  },
  {
    id: 'preset-enum-switch',
    label: '枚举映射 + 新增分支穷尽修复',
    category: 'ENUM_EXT',
    description: '迁移状态重命名并通过 WIT-ENUM 见证捕获 switch 新增分支异常，自动补齐安全兜底。',
    expectedRounds: 2,
    request: {
      title: '物流状态机：枚举映射 + WIT-ENUM 分支穷尽性修复',
      mode: 'symbolic',
      maxRounds: 4,
      enableAdversarialFuzzing: true,
      baseline: {
        openapi: '3.0.3',
        info: { title: 'Shipping API', version: '1.0.0' },
        paths: {
          '/shipments/{id}': {
            get: {
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
              responses: {
                '200': {
                  description: 'Shipment state',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['id', 'state'],
                        properties: {
                          id: { type: 'string' },
                          state: { type: 'string', enum: ['PENDING', 'DISPATCHED', 'DELIVERED'] },
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
      candidate: {
        openapi: '3.0.3',
        info: { title: 'Shipping API', version: '2.0.0' },
        paths: {
          '/shipments/{id}': {
            get: {
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
              responses: {
                '200': {
                  description: 'Shipment state v2',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['id', 'state'],
                        properties: {
                          id: { type: 'string' },
                          state: {
                            type: 'string',
                            enum: ['PENDING', 'IN_TRANSIT', 'DELIVERED', 'CUSTOMS_HOLD'],
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
      seedBaselineResponses: {
        'GET /shipments/{id}': {
          status: 200,
          body: { id: 'SHP-9', state: 'DISPATCHED' },
        },
      },
      callerFiles: [
        {
          path: 'src/shipment-status.ts',
          content: [
            'export async function describeShipment(shipmentId: string): Promise<string> {',
            '  const res = await fetch(`https://api.contractguard.local/shipments/${shipmentId}`);',
            '  const shipment = await res.json();',
            '  switch (shipment.state) {',
            "    case 'PENDING': return 'WAITING';",
            "    case 'DISPATCHED': return 'ON_THE_WAY';",
            "    case 'DELIVERED': return 'DONE';",
            "    default: throw new Error(`Unhandled shipment state: ${shipment.state}`);",
            '  }',
            '}',
            '',
          ].join('\n'),
        },
      ],
      testFiles: [
        {
          path: 'tests/shipment-status.test.mjs',
          content: [
            "import test from 'node:test';",
            "import assert from 'node:assert/strict';",
            "import { describeShipment } from '../src/shipment-status.ts';",
            '',
            "test('maps active shipment state', async () => {",
            "  const label = await describeShipment('SHP-9');",
            "  assert.equal(label, 'ON_THE_WAY');",
            '});',
            '',
          ].join('\n'),
        },
      ],
      probes: [{ file: 'src/shipment-status.ts', exportName: 'describeShipment', args: ['SHP-9'] }],
    },
  },
  {
    id: 'preset-multi-file-wrapper',
    label: '跨模块切片 + 必填请求参数迁移',
    category: 'MULTI_FILE + REQUEST_TIGHTEN',
    description: '跨 3 个模块追踪 HTTP 响应数据流，同步修复新增必填查询参数与嵌套属性。',
    expectedRounds: 1,
    request: {
      title: '跨模块客户端封装：数据流切片 + 请求参数收紧迁移',
      mode: 'symbolic',
      maxRounds: 4,
      enableAdversarialFuzzing: true,
      baseline: {
        openapi: '3.0.3',
        info: { title: 'Directory API', version: '1.0.0' },
        paths: {
          '/members/{id}': {
            get: {
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
              responses: {
                '200': {
                  description: 'Member profile',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['id', 'userName', 'department'],
                        properties: {
                          id: { type: 'string' },
                          userName: { type: 'string' },
                          department: { type: 'string' },
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
      candidate: {
        openapi: '3.0.3',
        info: { title: 'Directory API', version: '2.0.0' },
        paths: {
          '/members/{id}': {
            get: {
              parameters: [
                { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                { name: 'apiVersion', in: 'query', required: true, schema: { type: 'string', enum: ['2026-11'] } },
              ],
              responses: {
                '200': {
                  description: 'Member profile v2',
                  content: {
                    'application/json': {
                      schema: {
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
        'GET /members/{id}': {
          status: 200,
          body: { id: 'MEM-7', userName: 'Grace Hopper', department: 'Core Systems' },
        },
      },
      callerFiles: [
        {
          path: 'src/http-client.ts',
          content: [
            'export const httpClient = {',
            '  async get(url: string): Promise<any> {',
            '    const response = await fetch(url);',
            '    return await response.json();',
            '  },',
            '};',
            '',
          ].join('\n'),
        },
        {
          path: 'src/user-repo.ts',
          content: [
            "import { httpClient } from './http-client.ts';",
            '',
            'export async function fetchMemberRecord(memberId: string) {',
            '  return await httpClient.get(`https://api.contractguard.local/members/${memberId}`);',
            '}',
            '',
          ].join('\n'),
        },
        {
          path: 'src/badge-view.ts',
          content: [
            "import { fetchMemberRecord } from './user-repo.ts';",
            '',
            'export async function renderMemberChip(memberId: string): Promise<string> {',
            '  const member = await fetchMemberRecord(memberId);',
            '  return `${member.userName} (${member.department})`;',
            '}',
            '',
          ].join('\n'),
        },
      ],
      testFiles: [
        {
          path: 'tests/badge-view.test.mjs',
          content: [
            "import test from 'node:test';",
            "import assert from 'node:assert/strict';",
            "import { renderMemberChip } from '../src/badge-view.ts';",
            '',
            "test('renders member chip across 3-module wrapper chain', async () => {",
            "  const chip = await renderMemberChip('MEM-7');",
            "  assert.equal(chip, 'Grace Hopper (Core Systems)');",
            '});',
            '',
          ].join('\n'),
        },
      ],
      probes: [{ file: 'src/badge-view.ts', exportName: 'renderMemberChip', args: ['MEM-7'] }],
    },
  },
  {
    id: 'preset-unused-breaking-control',
    label: '不可达破坏性变更自动剪枝',
    category: 'REACHABILITY_PRUNING',
    description: '证明被删字段在当前调用链不可达，零补丁通过全部四道验证门，消除误报。',
    expectedRounds: 0,
    request: {
      title: '账户卡片：不可达破坏性变更自动剪枝对照',
      mode: 'symbolic',
      maxRounds: 4,
      enableAdversarialFuzzing: true,
      baseline: {
        openapi: '3.0.3',
        info: { title: 'Accounts API', version: '1.0.0' },
        paths: {
          '/accounts/{id}': {
            get: {
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
              responses: {
                '200': {
                  description: 'Account details',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['id', 'companyName', 'legacyFaxNumber', 'internalTaxCode'],
                        properties: {
                          id: { type: 'string' },
                          companyName: { type: 'string' },
                          legacyFaxNumber: { type: 'string' },
                          internalTaxCode: { type: 'string' },
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
      candidate: {
        openapi: '3.0.3',
        info: { title: 'Accounts API', version: '2.0.0' },
        paths: {
          '/accounts/{id}': {
            get: {
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
              responses: {
                '200': {
                  description: 'Account details v2',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['id', 'companyName'],
                        properties: {
                          id: { type: 'string' },
                          companyName: { type: 'string' },
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
      seedBaselineResponses: {
        'GET /accounts/{id}': {
          status: 200,
          body: {
            id: 'ACC-42',
            companyName: 'Clearwater Labs',
            legacyFaxNumber: '+852-0000-0000',
            internalTaxCode: 'HK-991',
          },
        },
      },
      callerFiles: [
        {
          path: 'src/account-card.ts',
          content: [
            'export function normalizeRegionTag(region: string): string {',
            '  return region.trim().toUpperCase() || "GLOBAL";',
            '}',
            '',
            'export function summarizeAuditWindow(days: number): string {',
            '  return `${Math.max(1, days)}d-window`;',
            '}',
            '',
            'export async function loadAccountTitle(accountId: string): Promise<string> {',
            '  const response = await fetch(`https://api.contractguard.local/accounts/${accountId}`);',
            '  const account = await response.json();',
            '  return `${account.id} · ${account.companyName}`;',
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
            '',
            "test('loads account title using only stable fields', async () => {",
            "  const title = await loadAccountTitle('ACC-42');",
            "  assert.equal(title, 'ACC-42 · Clearwater Labs');",
            '});',
            '',
          ].join('\n'),
        },
      ],
      probes: [{ file: 'src/account-card.ts', exportName: 'loadAccountTitle', args: ['ACC-42'] }],
    },
  },
];
