import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CegarWorkspace from './components/CegarWorkspace.vue'
import type { CegarPresetItem, CegarRunRecord, CegarStatusInfo } from './cegar-api'

const cegarApi = vi.hoisted(() => ({
  getCegarStatus: vi.fn(),
  listCegarPresets: vi.fn(),
  listCegarRuns: vi.fn(),
  getCegarRun: vi.fn(),
  startCegarRun: vi.fn(),
  downloadCegarReport: vi.fn(),
}))

vi.mock('./cegar-api', () => cegarApi)

const mockStatus: CegarStatusInfo = {
  service: 'contractguard-cegar-agent',
  modes: ['symbolic', 'llm', 'hybrid'],
  gates: ['typescript-typechecker', 'baseline-nominal-node-test', 'outbound-request-contract', 'differential-adversarial-witness-fuzzing'],
  llm: { available: false, activeProfile: 'deepseek', providers: [] },
}

const mockPreset: CegarPresetItem = {
  id: 'preset-nested-nullable',
  label: '2 轮反例精化：订单结构嵌套 + 可空字段崩溃',
  category: 'STRUCTURAL + NULLABILITY',
  description: '演示 WIT-NULL 反例精化闭环。',
  expectedRounds: 2,
  request: {
    title: '订单徽章迁移',
    mode: 'symbolic',
    maxRounds: 4,
    enableAdversarialFuzzing: true,
    baseline: { openapi: '3.0.3' },
    candidate: { openapi: '3.0.3' },
    callerFiles: [{ path: 'src/order-card.ts', content: 'export async function loadOrderBadge() { return ""; }\n' }],
    testFiles: [{ path: 'tests/order-card.test.mjs', content: '' }],
  },
}

const mockRunRecord: CegarRunRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  title: '订单徽章迁移',
  createdAt: '2026-11-08T06:00:00Z',
  mode: 'symbolic',
  maxRounds: 4,
  enableAdversarialFuzzing: true,
  releaseGate: 'blocked',
  callerImpactStatus: 'regression-repaired-verified',
  patchStatus: 'verified',
  alignment: {
    hypotheses: [
      {
        id: 'HYP-0001',
        kind: 'structural-nest',
        operation: { method: 'GET', path: '/orders/{id}' },
        fromPath: 'reviewerName',
        toPath: 'reviewer.name',
        confidence: 0.94,
        rationale: 'Nested reviewer object',
      },
    ],
  },
  dataflow: {
    slices: [],
    metrics: { totalFiles: 1, impactedFiles: 1, fullTokensApprox: 200, slicedTokensApprox: 90, compressionRatio: 0.45 },
    reachability: { staticBreakingCount: 2, reachableBreakingChangeIds: ['C1'], unreachableBreakingChangeIds: [], hasUncalledBreakingOnly: false },
  },
  witnesses: {
    operations: 1,
    adversarialCount: 1,
    suites: [
      {
        operation: { method: 'GET', path: '/orders/{id}' },
        adversarial: [{ id: 'WIT-NULL-0003', kind: 'adversarial-null', targetPath: 'reviewer', description: 'reviewer = null' }],
      },
    ],
  },
  rounds: [
    {
      round: 1,
      proposer: 'symbolic-ast',
      actionSummary: '迁移 reviewerName -> reviewer.name',
      citedHypothesisIds: ['HYP-0001'],
      citedCounterexampleIds: [],
      patches: [],
      verification: {
        verified: false,
        compilerClean: true,
        nominalPassed: true,
        requestContractPassed: true,
        adversarialPassed: 0,
        adversarialTotal: 1,
      },
      counterexamples: [
        {
          id: 'CEX-0001',
          kind: 'adversarial-witness-crash',
          file: 'src/order-card.ts',
          line: 14,
          witnessId: 'WIT-NULL-0003',
          message: "TypeError: Cannot read properties of null (reading 'name')",
        },
      ],
      durationMs: 420,
    },
    {
      round: 2,
      proposer: 'symbolic-ast',
      actionSummary: '根据 WIT-NULL-0003 补齐可选链与空值合并',
      citedHypothesisIds: [],
      citedCounterexampleIds: ['CEX-0001'],
      patches: [],
      verification: {
        verified: true,
        compilerClean: true,
        nominalPassed: true,
        requestContractPassed: true,
        adversarialPassed: 1,
        adversarialTotal: 1,
      },
      counterexamples: [],
      durationMs: 410,
    },
  ],
  finalPatches: [
    {
      file: 'src/order-card.ts',
      sourceSha256: 'a'.repeat(64),
      patchedSha256: 'b'.repeat(64),
      unifiedDiff: '--- a/src/order-card.ts\n+++ b/src/order-card.ts\n@@ -1,1 +1,1 @@\n-order.reviewerName\n+(order?.reviewer?.name ?? "")\n',
      patchedContent: 'export async function loadOrderBadge() { return ""; }\n',
      rationale: 'Verified CEGAR patch',
    },
  ],
  llmCalls: 0,
  durationMs: 910,
  summary: '经过 2 轮反例驱动精化已验证通过全部 4 道验证门。',
}

describe('CegarWorkspace neuro-symbolic CEGAR workbench', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    cegarApi.getCegarStatus.mockResolvedValue(mockStatus)
    cegarApi.listCegarPresets.mockResolvedValue([mockPreset])
    cegarApi.listCegarRuns.mockResolvedValue([])
    cegarApi.startCegarRun.mockResolvedValue(mockRunRecord)
  })

  it('loads showcase presets and renders multi-round CEGAR counterexample trajectory and unified diff', async () => {
    const wrapper = mount(CegarWorkspace)
    await flushPromises()

    expect(wrapper.text()).toContain('2 轮反例精化：订单结构嵌套 + 可空字段崩溃')

    const runBtn = wrapper.findAll('button').find((b) => b.text().includes('运行 CEGAR 闭环'))!
    await runBtn.trigger('click')
    await flushPromises()

    expect(cegarApi.startCegarRun).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('已验证修复')
    expect(wrapper.text()).toContain('55%')
    expect(wrapper.text()).toContain('Round 1')
    expect(wrapper.text()).toContain('WIT-NULL-0003')
    expect(wrapper.text()).toContain('Round 2')
    expect(wrapper.text()).toContain('全部验证门通过')
    expect(wrapper.text()).toContain('+(order?.reviewer?.name ?? "")')
  })
})
