import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.vue'
import { bundleFromFiles } from './bundle-input'
import type { AnalysisRecord } from './types'

const api = vi.hoisted(() => ({
  checkHealth: vi.fn(), createAnalysis: vi.fn(), deleteAnalysis: vi.fn(), downloadReport: vi.fn(),
  getAnalysis: vi.fn(), listAnalyses: vi.fn(), listRules: vi.fn(), getAiStatus: vi.fn(),
  listAiReviews: vi.fn(), generateAiReview: vi.fn(), downloadAiReview: vi.fn(),
}))
vi.mock('./api', () => ({ ...api, ApiError: class extends Error {} }))

function analysis(coverage = true): AnalysisRecord {
  const hash = { algorithm: 'sha256' as const, value: 'a'.repeat(64) }
  return {
    id: 'bundle-report', baselineName: 'old/openapi.yaml', candidateName: 'new/openapi.yaml',
    createdAt: '2026-10-27T00:00:00Z', engineVersion: '1.3.0', score: 100, compatible: true,
    summary: { total: 1, breaking: 0, potentiallyBreaking: 0, nonBreaking: 1, info: 0 },
    changes: [{ id: 'CG-0001', ruleId: 'TEST', severity: 'non-breaking', category: 'schema', location: 'paths.test', message: 'Example change',
      sourceLocations: { old: { file: 'schemas/order.yaml', pointer: '/properties/id' }, new: { file: 'schemas/order.yaml', pointer: '#/properties/id' } } }],
    source: { old: { dialect: 'openapi-3.0', bundle: { entry: 'openapi.yaml', files: [{ path: 'schemas/order.yaml', fingerprint: hash }] } }, new: { dialect: 'openapi-3.1' } },
    coverage: coverage ? { status: 'partial', truncated: false, warnings: [{ side: 'new', code: 'WEBHOOK_UNSUPPORTED', location: 'webhooks', message: 'Webhook impact requires review', source: { file: 'openapi.yaml', pointer: '#/webhooks' } }] } : undefined,
  }
}

function button(wrapper: VueWrapper, label: string) {
  const result = wrapper.findAll('button').find((item) => item.text().replace(/\s+/g, '') === label.replace(/\s+/g, ''))
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}

function file(name: string, content: string, relativePath = '', text?: () => Promise<string>): File {
  const selected = new File([content], name, { type: 'text/yaml' })
  Object.defineProperty(selected, 'webkitRelativePath', { value: relativePath })
  Object.defineProperty(selected, 'text', { value: text ?? (() => Promise.resolve(content)) })
  return selected
}

async function selectFiles(input: DOMWrapper<Element>, files: File[]) {
  Object.defineProperty(input.element, 'files', { value: files, configurable: true })
  await input.trigger('change')
}

let wrapper: VueWrapper | undefined
beforeEach(() => {
  vi.resetAllMocks()
  api.checkHealth.mockResolvedValue(true)
  api.listAnalyses.mockResolvedValue([])
  api.createAnalysis.mockResolvedValue(analysis())
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

async function bundleMode(page: VueWrapper) {
  await page.find('[aria-label="基线规范输入模式"]').findAll('button')[1]!.trigger('click')
}

describe('V1.3 bundle workspace', () => {
  it('submits two multi-file demos and shows coverage separately from a 100 score', async () => {
    const page = await start()
    await button(page, '载入多文件示例').trigger('click')
    expect(page.find('textarea.spec-editor').exists()).toBe(false)
    expect(page.findAll('.bundle-panel')).toHaveLength(2)
    await button(page, '运行兼容性分析').trigger('click')
    await flushPromises()
    expect(api.createAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      baseline: expect.objectContaining({ kind: 'bundle', entry: 'openapi.yaml', files: expect.arrayContaining([expect.objectContaining({ path: 'schemas/order.yaml' })]) }),
      candidate: expect.objectContaining({ kind: 'bundle', entry: 'openapi.yaml' }),
    }), expect.any(AbortSignal))
    expect(page.find('.coverage-panel').text()).toContain('存在未覆盖或需要人工复核')
    expect(page.find('.coverage-panel').text()).toContain('即使没有 breaking 或评分为 100')
    expect(page.text()).toContain('WEBHOOK_UNSUPPORTED')
    expect(page.text()).toContain('openapi-3.0')
    expect(page.text()).toContain('契约包入口')
    await page.find('.change-card__summary').trigger('click')
    expect(page.find('.finding-origins').text()).toContain('schemas/order.yaml#/properties/id')
    expect(page.find('.finding-origins').text()).not.toContain('##')
    expect(page.find('.coverage-panel').text()).toContain('openapi.yaml#/webhooks')
    expect(page.find('.coverage-panel').text()).not.toContain('##')
  })

  it('imports a directory, strips its selected root, and preserves nested references', async () => {
    const page = await start()
    await bundleMode(page)
    await selectFiles(page.find('input[aria-label="导入基线规范契约目录"]'), [
      file('order.yaml', 'type: string', 'contracts/schemas/order.yaml'),
      file('openapi.yaml', 'openapi: 3.1.0\npaths: {}', 'contracts/openapi.yaml'),
    ])
    await flushPromises()
    expect((page.find('select[aria-label="基线规范入口文件"]').element as HTMLSelectElement).value).toBe('openapi.yaml')
    await button(page, '运行兼容性分析').trigger('click')
    await flushPromises()
    expect(api.createAnalysis.mock.calls[0]![0].baseline).toEqual({ kind: 'bundle', entry: 'openapi.yaml', files: [
      { path: 'openapi.yaml', content: 'openapi: 3.1.0\npaths: {}' },
      { path: 'schemas/order.yaml', content: 'type: string' },
    ] })
  })

  it('lets the user explicitly choose another entry and switch back to fresh text input', async () => {
    const page = await start()
    await bundleMode(page)
    await selectFiles(page.find('input[aria-label="导入基线规范多个文件"]'), [
      file('openapi.yaml', 'openapi: 3.1.0\npaths: {}'), file('alternate.json', '{"openapi":"3.1.0","paths":{}}'),
    ])
    await flushPromises()
    await page.find('select[aria-label="基线规范入口文件"]').setValue('alternate.json')
    await button(page, '运行兼容性分析').trigger('click')
    await flushPromises()
    expect(api.createAnalysis.mock.calls[0]![0].baseline.entry).toBe('alternate.json')
    await page.find('[aria-label="基线规范输入模式"]').findAll('button')[0]!.trigger('click')
    expect((page.findAll('textarea.spec-editor')[0]!.element as HTMLTextAreaElement).value).toBe('')
    await page.findAll('textarea.spec-editor')[0]!.setValue('openapi: 3.1.0\npaths: {}')
    await button(page, '运行兼容性分析').trigger('click')
    await flushPromises()
    expect(api.createAnalysis.mock.calls[1]![0].baseline).toBe('openapi: 3.1.0\npaths: {}')
  })

  it('rejects duplicate selected names without silently overwriting a file', async () => {
    const page = await start()
    await bundleMode(page)
    await selectFiles(page.find('input[aria-label="导入基线规范多个文件"]'), [file('Order.yaml', 'type: string'), file('order.yaml', 'type: number')])
    await flushPromises()
    expect(page.find('[role="alert"]').text()).toContain('文件路径重复或仅大小写不同')
    expect(api.createAnalysis).not.toHaveBeenCalled()
  })

  it.each(['清空', '载入演示规范'])('discards delayed file reads after %s', async (action) => {
    let complete!: (value: string) => void
    const pending = new Promise<string>((resolve) => { complete = resolve })
    const page = await start()
    await bundleMode(page)
    await selectFiles(page.find('input[aria-label="导入基线规范多个文件"]'), [file('late.yaml', '', '', () => pending)])
    expect(page.text()).toContain('正在读取选择的文件')
    await button(page, action).trigger('click')
    complete('openapi: 3.1.0\npaths: {}')
    await flushPromises()
    expect(page.find('.bundle-panel').exists()).toBe(false)
    expect(page.text()).not.toContain('late.yaml')
    const value = (page.find('textarea.spec-editor').element as HTMLTextAreaElement).value
    if (action === '清空') expect(value).toBe('')
    else expect(value).toContain('openapi: 3.0.3')
    expect(page.text()).not.toContain('正在读取选择的文件')
  })

  it('labels old reports as unknown rather than inventing complete coverage', async () => {
    api.createAnalysis.mockResolvedValue(analysis(false))
    const page = await start()
    await button(page, '运行兼容性分析').trigger('click')
    await flushPromises()
    expect(page.find('.coverage-panel').text()).toContain('旧报告未记录覆盖范围')
    expect(page.find('.coverage-panel').text()).not.toContain('未发现已知覆盖缺口')
  })
})

describe('selected contract file safeguards', () => {
  it('rejects too many files before reading contents', async () => {
    const text = vi.fn(async () => '')
    await expect(bundleFromFiles(Array.from({ length: 51 }, (_, index) => file(`${index}.yaml`, '', '', text)), false)).rejects.toThrow('50')
    expect(text).not.toHaveBeenCalled()
  })
  it('rejects oversized content, path ambiguity, and empty selections', async () => {
    const oversized = file('large.yaml', '')
    Object.defineProperty(oversized, 'size', { value: 5 * 1024 * 1024 + 1 })
    await expect(bundleFromFiles([oversized], false)).rejects.toThrow('5 MiB')
    await expect(bundleFromFiles([file('x.yaml', '', 'root/../x.yaml')], true)).rejects.toThrow('路径')
    await expect(bundleFromFiles([], false)).rejects.toThrow('没有 YAML')
  })
})
