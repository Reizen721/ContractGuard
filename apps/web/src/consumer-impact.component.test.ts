import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.vue'
import ConsumerImpactPanel from './components/ConsumerImpactPanel.vue'
import HistoryPanel from './components/HistoryPanel.vue'
import { normalizeConsumerImpact, parseConsumerEvidence } from './consumer-evidence'
import { consumerExample } from './consumer-samples'
import { normalizeAnalysis, normalizeAnalysisList, normalizeAiReview } from './utils'
import type { AnalysisRecord, ConsumerImpactReport } from './types'

const api = vi.hoisted(() => ({
  checkHealth: vi.fn(), createAnalysis: vi.fn(), deleteAnalysis: vi.fn(), downloadReport: vi.fn(),
  getAnalysis: vi.fn(), listAnalyses: vi.fn(), listRules: vi.fn(), getAiStatus: vi.fn(),
  listAiReviews: vi.fn(), generateAiReview: vi.fn(), downloadAiReview: vi.fn(),
}))
vi.mock('./api', () => ({ ...api, ApiError: class extends Error {} }))

function impact(): ConsumerImpactReport {
  return {
    schemaVersion: 1, evidenceKind: 'supplied-examples', fingerprint: { algorithm: 'sha256', value: 'a'.repeat(64) }, gate: 'blocked',
    summary: { consumers: 1, interactions: 1, checks: 1, passed: 0, regressions: 1, invalidBaselines: 0, inconclusive: 0 },
    consumers: [{ id: 'mobile', name: 'Mobile checkout', owner: 'Checkout team', criticality: 'critical', checks: [{
      id: 'CC-mobile-order-response', interactionId: 'order', name: 'Read receipt', kind: 'response', method: 'POST', path: '/orders', status: 'regression',
      baseline: { status: 'valid', issues: [], truncated: false },
      candidate: { status: 'invalid', issues: [{ code: 'REQUIRED', path: '/receiptUrl', message: 'A required field is absent.' }], truncated: false },
      relatedChangeIds: ['CG-0001'], note: 'The candidate sample fails the supplied consumer expectation.',
    }] }],
    unmappedChangeIds: [],
    migrationTasks: [{ id: 'MT-mobile', consumerId: 'mobile', owner: 'Checkout team', priority: 'high', checkIds: ['CC-mobile-order-response'], changeIds: ['CG-0001'], action: 'Restore the receipt field.', verification: 'Supply new samples and rerun this interaction.' }],
    limitations: ['Only supplied examples were evaluated; no live API was called.'],
  }
}
function analysis(consumerImpact?: ConsumerImpactReport): AnalysisRecord {
  return {
    id: 'consumer-report', baselineName: 'old.json', candidateName: 'new.json', createdAt: '2026-11-02T00:00:00Z',
    score: 100, compatible: true, summary: { breaking: 0, potentiallyBreaking: 0, nonBreaking: 0, info: 0, total: 0 }, changes: [], consumerImpact,
  }
}
function button(wrapper: VueWrapper, label: string) {
  const result = wrapper.findAll('button').find((item) => item.text().replace(/\s+/g, '') === label.replace(/\s+/g, ''))
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
function file(content: string, read?: () => Promise<string>): File {
  const value = new File([content], 'consumers.json', { type: 'application/json' })
  Object.defineProperty(value, 'text', { value: read ?? (() => Promise.resolve(content)) })
  return value
}
async function select(input: DOMWrapper<Element>, selected: File) {
  Object.defineProperty(input.element, 'files', { value: [selected], configurable: true })
  await input.trigger('change')
}
let wrapper: VueWrapper | undefined
beforeEach(() => {
  vi.resetAllMocks()
  api.checkHealth.mockResolvedValue(true)
  api.listAnalyses.mockResolvedValue([])
  api.listRules.mockResolvedValue([])
  api.createAnalysis.mockResolvedValue(analysis(impact()))
  api.getAiStatus.mockResolvedValue({ enabled: false, available: false, configured: false, provider: 'deepseek', model: 'mock', providers: [], allowRequestProviderOverride: false })
  api.listAiReviews.mockResolvedValue([])
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals() })
async function start() {
  wrapper = mount(App)
  await flushPromises()
  await button(wrapper, '载入调用方示例').trigger('click')
  return wrapper
}

describe('consumer evidence workspace', () => {
  it('loads the shared demo, submits all inputs and distinguishes consumer failures from a static score', async () => {
    const page = await start()
    const demo = consumerExample()
    await button(page, '运行兼容性分析').trigger('click')
    await flushPromises()
    expect(api.createAnalysis).toHaveBeenCalledWith(expect.objectContaining({ baseline: demo.baseline, candidate: demo.candidate, consumerEvidence: JSON.parse(demo.evidence) }), expect.any(AbortSignal))
    const panel = page.find('.consumer-impact')
    expect(panel.text()).toContain('发现样例回归')
    expect(panel.text()).toContain('Checkout team')
    expect(panel.text()).toContain('REQUIRED · /receiptUrl')
    expect(panel.text()).toContain('迁移与补证清单')
    expect(panel.text()).toContain('不代表完整调用流量或实际服务测试')
    expect(panel.text()).not.toContain('order-demo-001')
    await page.find('#consumer-evidence-json').setValue('{}')
    expect(page.text()).toContain('输入已变更')
  })

  it('blocks malformed JSON and allows a corrected retry without losing the contracts', async () => {
    const page = await start()
    await page.find('#consumer-evidence-json').setValue('{oops')
    expect(page.find('#consumer-input-error').text()).toContain('不是有效的 JSON')
    expect(button(page, '运行兼容性分析').attributes('disabled')).toBeDefined()
    await page.find('#consumer-evidence-json').setValue(consumerExample().evidence)
    await button(page, '运行兼容性分析').trigger('click')
    await flushPromises()
    expect(api.createAnalysis).toHaveBeenCalledTimes(1)
  })

  it('aborts and discards a report when only consumer evidence changes during analysis', async () => {
    const pending = deferred<AnalysisRecord>()
    api.createAnalysis.mockReturnValueOnce(pending.promise)
    const page = await start()
    await button(page, '运行兼容性分析').trigger('click')
    const signal = api.createAnalysis.mock.calls[0]![1] as AbortSignal
    await page.find('#consumer-evidence-json').setValue('{}')
    expect(signal.aborted).toBe(true)
    pending.resolve(analysis(impact()))
    await flushPromises()
    expect(page.find('#analysis-results').exists()).toBe(false)
  })

  it.each(['载入演示规范', '载入多文件示例'])('clears evidence when switching to %s and omits optional evidence', async (action) => {
    const page = await start()
    await button(page, action).trigger('click')
    expect((page.find('#consumer-evidence-json').element as HTMLTextAreaElement).value).toBe('')
    await button(page, '运行兼容性分析').trigger('click')
    await flushPromises()
    expect(api.createAnalysis.mock.calls[0]![0]).not.toHaveProperty('consumerEvidence')
  })

  it.each(['清空', '载入演示规范', '载入调用方示例'])('discards a delayed sample file after %s', async (action) => {
    const pending = deferred<string>()
    const page = await start()
    await select(page.find('input[aria-label="导入调用方样例 JSON"]'), file('', () => pending.promise))
    expect(page.text()).toContain('正在读取样例')
    await button(page, action).trigger('click')
    pending.resolve('{"late":true}')
    await flushPromises()
    expect((page.find('#consumer-evidence-json').element as HTMLTextAreaElement).value).not.toContain('late')
    expect(page.text()).not.toContain('正在读取样例')
  })

  it('retains a direct edit instead of overwriting it with a delayed file read', async () => {
    const pending = deferred<string>()
    const page = await start()
    await select(page.find('input[aria-label="导入调用方样例 JSON"]'), file('', () => pending.promise))
    await page.find('#consumer-evidence-json').setValue('{"edited":true}')
    pending.resolve('{"late":true}')
    await flushPromises()
    expect((page.find('#consumer-evidence-json').element as HTMLTextAreaElement).value).toBe('{"edited":true}')
  })

  it('checks file size before reading and preserves prior evidence on an invalid import', async () => {
    const page = await start()
    const read = vi.fn(async () => '{}')
    const oversized = file('', read)
    Object.defineProperty(oversized, 'size', { value: 1024 * 1024 + 1 })
    await select(page.find('input[aria-label="导入调用方样例 JSON"]'), oversized)
    await flushPromises()
    expect(read).not.toHaveBeenCalled()
    expect(page.find('#consumer-input-error').text()).toContain('1 MiB')
    await select(page.find('input[aria-label="导入调用方样例 JSON"]'), file('[]'))
    await flushPromises()
    expect(page.find('#consumer-input-error').text()).toContain('现有输入未被替换')
    expect((page.find('#consumer-evidence-json').element as HTMLTextAreaElement).value).toBe(consumerExample().evidence)
  })

  it('opens a historical evidence report read-only and preserves the current draft', async () => {
    api.listAnalyses.mockResolvedValue([analysis(impact())])
    api.getAnalysis.mockResolvedValue(analysis(impact()))
    const page = await start()
    await button(page, '分析历史1').trigger('click')
    await flushPromises()
    await page.find('.history-title').trigger('click')
    await flushPromises()
    expect(page.find('#consumer-evidence-json').exists()).toBe(false)
    expect(page.find('.consumer-impact').text()).toContain('Checkout team')
    await button(page, '返回编辑区').trigger('click')
    expect((page.find('#consumer-evidence-json').element as HTMLTextAreaElement).value).toBe(consumerExample().evidence)
  })
})

describe('consumer report compatibility and integrity', () => {
  it('shows blocked and uncertain consumer history independently of identical green static scores', () => {
    const failed = impact().summary
    const uncertain = { ...failed, regressions: 0, inconclusive: 1 }
    const passed = { ...failed, regressions: 0, passed: 1 }
    const records = normalizeAnalysisList({ analyses: [
      { ...analysis(), id: 'blocked', consumerGate: 'blocked', consumerSummary: failed },
      { ...analysis(), id: 'review', consumerGate: 'review', consumerSummary: uncertain },
      { ...analysis(), id: 'pass', consumerGate: 'pass', consumerSummary: passed },
      { ...analysis(), id: 'legacy' },
    ] })
    wrapper = mount(HistoryPanel, { props: { analyses: records, loading: false, error: '' } })
    expect(wrapper.findAll('th').map((item) => item.text())).toContain('静态评分')
    const rows = wrapper.findAll('tbody tr')
    expect(rows.every((row) => row.find('.score-badge').text() === '100')).toBe(true)
    expect(rows[0]!.find('.history-consumer').text()).toContain('发现样例回归')
    expect(rows[0]!.find('.consumer-status--blocked').exists()).toBe(true)
    expect(rows[1]!.find('.history-consumer').text()).toContain('需要复核')
    expect(rows[1]!.find('.history-consumer').text()).toContain('1 待确认')
    expect(rows[2]!.find('.history-consumer').text()).toContain('样例范围内通过')
    expect(rows[3]!.find('.history-consumer').text()).toContain('未记录验证')
    expect(rows[3]!.find('.history-consumer').text()).not.toContain('通过')
  })

  it('rejects contradictory compact success and derives history from valid full evidence first', () => {
    const failed = impact().summary
    const invalid = normalizeAnalysis({ ...analysis(), consumerGate: 'pass', consumerSummary: failed })
    expect(invalid.consumerGate).toBeUndefined()
    expect(invalid.consumerImpactError).toContain('不完整')
    const invalidCount = normalizeAnalysis({ ...analysis(), consumerGate: 'pass', consumerSummary: { ...failed, regressions: 0, passed: '1' } })
    expect(invalidCount.consumerGate).toBeUndefined()
    const full = normalizeAnalysis({ ...analysis(impact()), consumerGate: 'pass', consumerSummary: { ...failed, regressions: 0, passed: 1 } })
    expect(full.consumerGate).toBe('blocked')
    expect(full.consumerSummary).toEqual(failed)
    const corruptFull = normalizeAnalysis({ ...analysis(), consumerImpact: {}, consumerGate: 'pass', consumerSummary: { ...failed, regressions: 0, passed: 1 } })
    expect(corruptFull.consumerGate).toBeUndefined()
    wrapper = mount(HistoryPanel, { props: { analyses: [invalid], loading: false, error: '' } })
    expect(wrapper.find('.history-consumer').text()).toContain('结果待复核')
    expect(wrapper.find('.history-consumer').text()).not.toContain('通过')
  })

  it('preserves supported evidence and v4 AI metadata while old records remain explicitly unverified', () => {
    expect(normalizeAnalysis(analysis(impact())).consumerImpact).toEqual(impact())
    expect(normalizeAiReview({ promptVersion: 'ai-explainer-v4' }).promptVersion).toBe('ai-explainer-v4')
    wrapper = mount(ConsumerImpactPanel)
    expect(wrapper.text()).toContain('未运行调用方样例验证')
    expect(wrapper.text()).not.toContain('样例范围内通过')
  })

  it('rejects corrupted success claims and reports a visible error instead of falling back to pass', () => {
    const broken = impact()
    broken.gate = 'pass'
    expect(normalizeConsumerImpact(broken)).toBeUndefined()
    const report = normalizeAnalysis(analysis(broken))
    expect(report.consumerImpactError).toContain('不完整或版本不受支持')
    wrapper = mount(ConsumerImpactPanel, { props: { report: report.consumerImpact, error: report.consumerImpactError } })
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('样例范围内通过')
  })

  it('does not turn incomplete checks, duplicate identities, or mismatched counts into valid reports', () => {
    const missing = impact()
    missing.consumers[0]!.checks[0]!.status = 'pass'
    expect(normalizeConsumerImpact(missing)).toBeUndefined()
    const duplicate = impact()
    duplicate.consumers.push(structuredClone(duplicate.consumers[0]!))
    expect(normalizeConsumerImpact(duplicate)).toBeUndefined()
    const mismatch = impact()
    mismatch.summary.checks = 0
    expect(normalizeConsumerImpact(mismatch)).toBeUndefined()
    expect(parseConsumerEvidence(' ')).toBeUndefined()
    expect(() => parseConsumerEvidence(JSON.stringify({ text: '中'.repeat(400000) }))).toThrow('1 MiB')
    expect(() => parseConsumerEvidence('null')).toThrow('JSON 对象')
  })
})
