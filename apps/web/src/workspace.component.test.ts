import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.vue'
import type { AnalysisRecord } from './types'

const api = vi.hoisted(() => ({
  checkHealth: vi.fn(), createAnalysis: vi.fn(), deleteAnalysis: vi.fn(), downloadReport: vi.fn(),
  getAnalysis: vi.fn(), listAnalyses: vi.fn(), listRules: vi.fn(), getAiStatus: vi.fn(),
  listAiReviews: vi.fn(), generateAiReview: vi.fn(), downloadAiReview: vi.fn(),
}))
vi.mock('./api', () => ({ ...api, ApiError: class extends Error {} }))

function analysis(id = 'saved-report'): AnalysisRecord {
  return {
    id, baselineName: 'old.yaml', candidateName: 'new.yaml', createdAt: '2026-10-27T00:00:00Z',
    score: 96, compatible: true, engineVersion: '1.2.0',
    summary: { total: 1, breaking: 0, potentiallyBreaking: 1, nonBreaking: 0, info: 0 },
    changes: [{ id: 'CG-0001', ruleId: 'SCHEMA_UNSUPPORTED_KEYWORD_CHANGED', severity: 'potentially-breaking', category: 'schema', location: '/pets', message: 'Review this constraint' }],
    source: { old: { fingerprint: { algorithm: 'sha256', value: 'a'.repeat(64) } }, new: { fingerprint: { algorithm: 'sha256', value: 'b'.repeat(64) } } },
    policy: { id: 'review-policy', fingerprint: { algorithm: 'sha256', value: 'c'.repeat(64) } },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (value: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function button(wrapper: VueWrapper, text: string) {
  const found = wrapper.findAll('button').find((item) => item.text().replace(/\s+/g, '') === text.replace(/\s+/g, ''))
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}

let wrapper: VueWrapper | undefined
beforeEach(() => {
  vi.resetAllMocks()
  api.checkHealth.mockResolvedValue(true)
  api.listAnalyses.mockResolvedValue([])
  api.getAiStatus.mockResolvedValue({ enabled: false, available: false, configured: false, provider: 'deepseek', model: 'mock', providers: [], allowRequestProviderOverride: false })
  api.listAiReviews.mockResolvedValue([])
  api.listRules.mockResolvedValue([])
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals() })

async function start() {
  wrapper = mount(App)
  await flushPromises()
  await button(wrapper, '载入演示规范').trigger('click')
  return wrapper
}

describe('workspace component regression', () => {
  it('runs an analysis and labels provenance and uncertain results without claiming a gate passed', async () => {
    api.createAnalysis.mockResolvedValue(analysis())
    const page = await start()
    await button(page, '运行兼容性分析').trigger('click')
    await flushPromises()
    expect(page.text()).toContain('未发现确定性破坏')
    expect(page.text()).not.toContain('通过兼容性门禁')
    expect(page.text()).toContain('review-policy')
    expect(page.text()).toContain('a'.repeat(64))
    await page.findAll('textarea.spec-editor')[1]!.setValue('new draft')
    expect(page.text()).toContain('输入已变更')
  })

  it('aborts and discards a slow analysis when the workspace is cleared', async () => {
    const pending = deferred<AnalysisRecord>()
    api.createAnalysis.mockReturnValue(pending.promise)
    const page = await start()
    await button(page, '运行兼容性分析').trigger('click')
    const signal = api.createAnalysis.mock.calls[0]![1] as AbortSignal
    await button(page, '清空').trigger('click')
    expect(signal.aborted).toBe(true)
    pending.resolve(analysis('outdated'))
    await flushPromises()
    expect(page.find('#analysis-results').exists()).toBe(false)
    expect((page.find('textarea.spec-editor').element as HTMLTextAreaElement).value).toBe('')
  })

  it('discards a slow response after an edit and accepts a later analysis instead', async () => {
    const old = deferred<AnalysisRecord>()
    api.createAnalysis.mockReturnValueOnce(old.promise).mockResolvedValueOnce(analysis('latest'))
    const page = await start()
    await button(page, '运行兼容性分析').trigger('click')
    await page.findAll('textarea.spec-editor')[1]!.setValue('new draft')
    await button(page, '运行兼容性分析').trigger('click')
    await flushPromises()
    old.resolve({ ...analysis('outdated'), candidateName: 'outdated.yaml' })
    await flushPromises()
    expect(page.find('#analysis-results h2').text()).toContain('new.yaml')
    expect(page.text()).not.toContain('outdated.yaml')
    expect(page.text()).not.toContain('输入已变更')
  })

  it('discards a slow response after loading another demo', async () => {
    const pending = deferred<AnalysisRecord>()
    api.createAnalysis.mockReturnValue(pending.promise)
    const page = await start()
    await button(page, '运行兼容性分析').trigger('click')
    await button(page, '载入演示规范').trigger('click')
    pending.resolve(analysis('outdated'))
    await flushPromises()
    expect(page.find('#analysis-results').exists()).toBe(false)
  })

  it('opens history in a read-only report view and preserves the draft separately', async () => {
    api.listAnalyses.mockResolvedValue([analysis()])
    api.getAnalysis.mockResolvedValue(analysis())
    const page = await start()
    const draft = (page.find('textarea.spec-editor').element as HTMLTextAreaElement).value
    await button(page, '分析历史1').trigger('click')
    await flushPromises()
    await page.find('.history-title').trigger('click')
    await flushPromises()
    expect(page.find('h1').text()).toBe('历史分析报告')
    expect(page.find('textarea.spec-editor').exists()).toBe(false)
    await button(page, '返回编辑区').trigger('click')
    expect((page.find('textarea.spec-editor').element as HTMLTextAreaElement).value).toBe(draft)
    expect(page.find('#analysis-results').exists()).toBe(false)
  })

  it('shows a parse failure and allows correction and retry', async () => {
    api.createAnalysis.mockRejectedValueOnce(new Error('Invalid YAML')).mockResolvedValueOnce(analysis())
    const page = await start()
    await button(page, '运行兼容性分析').trigger('click')
    await flushPromises()
    expect(page.text()).toContain('Invalid YAML')
    await page.findAll('textarea.spec-editor')[1]!.setValue('corrected draft')
    await button(page, '运行兼容性分析').trigger('click')
    await flushPromises()
    expect(page.find('#analysis-results').exists()).toBe(true)
  })

  it('filters and expands real findings and exports the displayed report', async () => {
    api.createAnalysis.mockResolvedValue(analysis())
    const page = await start()
    await button(page, '运行兼容性分析').trigger('click')
    await flushPromises()
    await page.find('input[type="search"]').setValue('missing rule')
    expect(page.text()).toContain('没有匹配的变更')
    await button(page, '清除筛选').trigger('click')
    await page.find('.change-card__summary').trigger('click')
    expect(page.find('.change-card__details').exists()).toBe(true)
    expect(page.find('.change-card__summary').attributes('aria-expanded')).toBe('true')
    await page.find('.export-menu > button').trigger('click')
    await page.find('#export-options button').trigger('click')
    await flushPromises()
    expect(api.downloadReport).toHaveBeenCalledWith(expect.objectContaining({ id: 'saved-report' }), 'markdown')
    expect(page.find('#export-options').exists()).toBe(false)
  })

  it('does not let a slow history open replace a cleared workspace', async () => {
    const pending = deferred<AnalysisRecord>()
    api.listAnalyses.mockResolvedValue([analysis()])
    api.getAnalysis.mockReturnValue(pending.promise)
    const page = await start()
    await button(page, '分析历史1').trigger('click')
    await flushPromises()
    await page.find('.history-title').trigger('click')
    await button(page, '新建分析').trigger('click')
    await button(page, '清空').trigger('click')
    pending.resolve(analysis('outdated'))
    await flushPromises()
    expect(page.find('h1').text()).toBe('OpenAPI 兼容性分析')
    expect(page.find('#analysis-results').exists()).toBe(false)
  })

  it('imports a file through the real SpecPanel file input', async () => {
    const page = await start()
    const input = page.find('input[aria-label="导入基线规范"]')
    const file = new File(['openapi: 3.1.0'], 'imported.yaml', { type: 'text/yaml' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('openapi: 3.1.0') })
    Object.defineProperty(input.element, 'files', { value: [file] })
    await input.trigger('change')
    await flushPromises()
    expect(page.text()).toContain('imported.yaml')
    expect((page.find('textarea.spec-editor').element as HTMLTextAreaElement).value).toBe('openapi: 3.1.0')
  })
})
