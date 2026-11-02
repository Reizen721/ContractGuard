import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AiReportInterpreter from './components/AiReportInterpreter.vue'
import type { AiReviewReport, AiServiceStatus } from './types'

const api = vi.hoisted(() => ({ generateAiReview: vi.fn(), getAiStatus: vi.fn(), listAiReviews: vi.fn(), downloadAiReview: vi.fn() }))
vi.mock('./api', () => api)

function status(): AiServiceStatus {
  return {
    enabled: true, configured: true, available: true, provider: 'deepseek', model: 'mock-a',
    activeProviderId: 'cloud-a', defaultProviderId: 'cloud-a', allowRequestProviderOverride: true,
    providers: ['a', 'b'].map((id) => ({ id: `cloud-${id}`, displayName: `Cloud ${id}`, provider: 'deepseek', model: `mock-${id}`, enabled: true, configured: true, available: true })),
  }
}
function review(overrides: Partial<AiReviewReport> = {}): AiReviewReport {
  return {
    id: 'review-1', analysisId: 'analysis-1', language: 'zh-CN', provider: 'deepseek', providerId: 'cloud-a', providerLabel: 'Cloud a',
    model: 'mock-a', schemaVersion: '1.0', generatedAt: '2026-10-27T01:00:00Z', promptVersion: 'ai-explainer-v2',
    overview: { headline: 'Saved explanation', executiveSummary: 'Migration evidence', riskLevel: 'high' },
    keyRisks: [], migrationPlan: [], testSuggestions: [], caveats: ['Manual review required'],
    coverage: { totalFindings: 20, includedFindings: 10, omittedFindings: 10, includedChangeIds: ['CG-0001'] },
    ...overrides,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
function button(wrapper: VueWrapper, text: string) {
  const found = wrapper.findAll('button').find((item) => item.text().trim() === text)
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}
let wrapper: VueWrapper | undefined
beforeEach(() => {
  vi.resetAllMocks()
  api.getAiStatus.mockResolvedValue(status())
  api.listAiReviews.mockResolvedValue([])
  api.downloadAiReview.mockResolvedValue(undefined)
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined })
async function start() {
  wrapper = mount(AiReportInterpreter, { props: { analysisId: 'analysis-1' } })
  await flushPromises()
  return wrapper
}

describe('AI review component regression', () => {
  it('restores saved coverage and focus without another model call, and exports the saved artifact', async () => {
    api.listAiReviews.mockResolvedValue([review({ focus: 'mobile migration' })])
    const page = await start()
    expect(page.text()).toContain('Saved explanation')
    expect((page.find('#ai-review-focus').element as HTMLTextAreaElement).value).toBe('mobile migration')
    expect(page.text()).toContain('10 / 20')
    expect(page.text()).toContain('10 条未发送给模型')
    expect(api.generateAiReview).not.toHaveBeenCalled()
    await button(page, '导出 AI 解读 Markdown').trigger('click')
    await flushPromises()
    expect(api.downloadAiReview).toHaveBeenCalledWith(expect.objectContaining({ id: 'review-1' }), 'markdown')
  })

  it('still reads saved reports when the AI service is disabled', async () => {
    api.getAiStatus.mockResolvedValue({ ...status(), enabled: false, available: false, providers: [] })
    api.listAiReviews.mockResolvedValue([review()])
    const page = await start()
    expect(page.text()).toContain('AI 解释器当前未启用')
    expect(page.text()).toContain('Saved explanation')
    expect(page.find('#ai-review-focus').exists()).toBe(false)
    expect(api.generateAiReview).not.toHaveBeenCalled()
  })

  it('does not implicitly show a different provider report as the selected provider', async () => {
    api.listAiReviews.mockResolvedValue([review({ providerId: 'cloud-b', providerLabel: 'Cloud b', model: 'mock-b' })])
    const page = await start()
    expect(page.find('.ai-report').exists()).toBe(false)
    expect((page.find('#ai-provider-select').element as HTMLSelectElement).value).toBe('cloud-a')
    await page.find('#ai-saved-select').setValue('review-1')
    expect(page.find('.ai-report__meta').text()).toContain('Cloud b · mock-b')
    expect((page.find('#ai-provider-select').element as HTMLSelectElement).value).toBe('cloud-b')
  })

  it('does not silently restore a saved report from a different model under the same profile ID', async () => {
    api.listAiReviews.mockResolvedValue([review({ model: 'old-model' })])
    const page = await start()
    expect(page.find('.ai-report').exists()).toBe(false)
    await page.find('#ai-saved-select').setValue('review-1')
    expect(page.find('.ai-report__meta').text()).toContain('old-model')
  })

  it('uses the reusable default request and sends force only on explicit regeneration', async () => {
    api.generateAiReview.mockResolvedValue(review())
    const page = await start()
    await button(page, '生成或读取 AI 解读').trigger('click')
    await flushPromises()
    expect(api.generateAiReview.mock.calls[0]![1]).toEqual({ language: 'zh-CN', providerId: 'cloud-a' })
    await button(page, '按当前选项重新生成（调用模型）').trigger('click')
    await flushPromises()
    expect(api.generateAiReview.mock.calls[1]![1]).toEqual({ language: 'zh-CN', providerId: 'cloud-a', force: true })
  })

  it('cancels a generation and discards a late response after changing provider', async () => {
    const pending = deferred<AiReviewReport>()
    api.generateAiReview.mockReturnValue(pending.promise)
    const page = await start()
    await button(page, '生成或读取 AI 解读').trigger('click')
    const signal = api.generateAiReview.mock.calls[0]![2] as AbortSignal
    await page.find('#ai-provider-select').setValue('cloud-b')
    expect(signal.aborted).toBe(true)
    pending.resolve(review())
    await flushPromises()
    expect(page.find('.ai-report').exists()).toBe(false)
    expect(page.text()).toContain('Cloud b 配置就绪')
  })

  it('supports explicit cancellation without rendering a late result', async () => {
    const pending = deferred<AiReviewReport>()
    api.generateAiReview.mockReturnValue(pending.promise)
    const page = await start()
    await button(page, '生成或读取 AI 解读').trigger('click')
    const signal = api.generateAiReview.mock.calls[0]![2] as AbortSignal
    await button(page, '取消生成').trigger('click')
    expect(signal.aborted).toBe(true)
    pending.resolve(review())
    await flushPromises()
    expect(page.find('.ai-report').exists()).toBe(false)
  })

  it('cancels a generation after changing the requested focus', async () => {
    const pending = deferred<AiReviewReport>()
    api.generateAiReview.mockReturnValue(pending.promise)
    const page = await start()
    await button(page, '生成或读取 AI 解读').trigger('click')
    const signal = api.generateAiReview.mock.calls[0]![2] as AbortSignal
    await page.find('#ai-review-focus').setValue('a different migration')
    pending.resolve(review())
    await flushPromises()
    expect(signal.aborted).toBe(true)
    expect(page.find('.ai-report').exists()).toBe(false)
  })

  it('does not let delayed history overwrite a newer generated report', async () => {
    const pending = deferred<AiReviewReport[]>()
    api.listAiReviews.mockReturnValue(pending.promise)
    api.generateAiReview.mockResolvedValue(review({ id: 'new-review', overview: { headline: 'New explanation', executiveSummary: 'Fresh', riskLevel: 'high' }, generatedAt: '2026-10-27T02:00:00Z' }))
    const page = await start()
    await button(page, '生成或读取 AI 解读').trigger('click')
    await flushPromises()
    pending.resolve([review()])
    await flushPromises()
    expect(page.find('#ai-report-headline').text()).toBe('New explanation')
    expect(page.findAll('#ai-saved-select option')).toHaveLength(3)
  })

  it('discards generation and old history when the analysis changes', async () => {
    const pending = deferred<AiReviewReport>()
    api.generateAiReview.mockReturnValue(pending.promise)
    const page = await start()
    await button(page, '生成或读取 AI 解读').trigger('click')
    api.listAiReviews.mockResolvedValue([review({ id: 'other', analysisId: 'analysis-2', overview: { headline: 'Other analysis', executiveSummary: 'Other', riskLevel: 'low' } })])
    await page.setProps({ analysisId: 'analysis-2' })
    pending.resolve(review())
    await flushPromises()
    expect(page.find('#ai-report-headline').text()).toBe('Other analysis')
    expect(api.listAiReviews).toHaveBeenLastCalledWith('analysis-2', expect.any(AbortSignal))
  })

  it('preserves the last saved report when regeneration fails and lets the reader select it again', async () => {
    api.listAiReviews.mockResolvedValue([review()])
    api.generateAiReview.mockRejectedValue(new Error('Temporary model failure'))
    const page = await start()
    await button(page, '按当前选项重新生成（调用模型）').trigger('click')
    await flushPromises()
    expect(page.text()).toContain('Temporary model failure')
    await page.find('#ai-saved-select').setValue('review-1')
    expect(page.find('#ai-report-headline').text()).toBe('Saved explanation')
  })
})
