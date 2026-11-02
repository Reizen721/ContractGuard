import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CallerWorkspace from './components/CallerWorkspace.vue'
import type { CallerRecord } from './caller-api'

const api = vi.hoisted(() => ({ createCallerReview: vi.fn(), downloadCallerReview: vi.fn(), getCallerReview: vi.fn(), listCallerReviews: vi.fn() }))
vi.mock('./caller-api', () => api)
const saved = {
  id: '3b514512-3ec0-44fe-8ac4-5376e025c491', createdAt: '2026-11-02T12:00:00.000Z',
  report: {
    schemaVersion: 1, toolVersion: '1.7.0', evidenceKind: 'bounded-typescript-replay', generatedAt: '2026-11-02T12:00:00.000Z',
    inputFingerprint: { algorithm: 'sha256', value: 'a'.repeat(64) }, sourceFiles: [{ path: 'orders.ts', sha256: 'b'.repeat(64) }],
    gate: 'blocked', summary: { files: 1, callsites: 1, resolved: 1, unknown: 0, checks: 1, passed: 0, regressions: 1, invalidBaselines: 0, inconclusive: 0, verifiedPatches: 1 },
    callsites: [{ id: 'site-1', file: 'orders.ts', line: 2, column: 20, exportName: 'label', client: 'fetch', method: 'GET', path: '/orders', status: 'resolved', fields: [{ path: 'name', line: 4, column: 10, start: 90, end: 94 }], relatedChangeIds: ['CG-0001'] }],
    checks: [{ id: 'check-1', scenarioId: 'order-label', file: 'orders.ts', exportName: 'label', operation: { method: 'GET', path: '/orders' }, status: 'regression', baseline: { status: 'passed', value: 'ALICE', steps: 4, requests: 1 }, candidate: { status: 'failed', error: 'Missing name', steps: 4, requests: 1 }, callsiteIds: ['site-1'], note: 'Explicit expected output differs.' }],
    patches: [{ id: 'patch-1', file: 'orders.ts', sourceSha256: 'b'.repeat(64), patchedSha256: 'c'.repeat(64), edits: [], patchedContent: 'return order.displayName', unifiedDiff: '-order.name\n+order.displayName', verification: { status: 'verified', checkIds: ['check-1'], results: [{ scenarioId: 'order-label', outcome: { status: 'passed', value: 'ALICE', steps: 4, requests: 1 } }], reason: 'Candidate replay passed.' } }],
    limitations: ['Only supported TypeScript syntax was interpreted.'], contractAnalysis: {},
  },
} as unknown as CallerRecord
let wrapper: VueWrapper | undefined
function button(text: string) { const found = wrapper!.findAll('button').find((item) => item.text() === text); if (!found) throw new Error(`Missing ${text}`); return found }
beforeEach(() => { vi.clearAllMocks(); api.listCallerReviews.mockResolvedValue([]); api.createCallerReview.mockResolvedValue(saved); api.getCallerReview.mockResolvedValue(saved); api.downloadCallerReview.mockResolvedValue(undefined) })
afterEach(() => wrapper?.unmount())
describe('caller migration workspace', () => {
  it('submits the exact demo object and keeps original blocked gate despite verified patch', async () => {
    wrapper = mount(CallerWorkspace)
    await flushPromises()
    await button('载入迁移示例').trigger('click')
    const input = JSON.parse(wrapper.get('textarea').element.value)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(api.createCallerReview.mock.calls[0]?.[0]).toEqual(input)
    expect(wrapper.get('[aria-label="调用方审查报告"]').text()).toContain('存在阻断风险')
    expect(wrapper.text()).toContain('orders.ts:2:20')
    expect(wrapper.text()).toContain('候选版本回归')
    expect(wrapper.text()).toContain('已在副本验证')
    expect(wrapper.text()).toContain('补丁验证通过不等于这次发布已通过')
    await button('导出 Markdown').trigger('click')
    expect(api.downloadCallerReview).toHaveBeenCalledWith(saved.id, 'markdown')
  })
  it('does not send malformed JSON or retain an unrelated old report', async () => {
    wrapper = mount(CallerWorkspace)
    await wrapper.get('textarea').setValue('{broken')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(api.createCallerReview).not.toHaveBeenCalled()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="调用方审查报告"]').exists()).toBe(false)
  })
  it('shows unknown evidence and unverified patch without presenting a pass', async () => {
    api.createCallerReview.mockResolvedValue({ ...saved, report: { ...saved.report, gate: 'review', callsites: [{ ...saved.report.callsites[0], status: 'unknown', path: null, reason: 'Dynamic request URL' }], patches: [{ ...saved.report.patches[0], verification: { status: 'unverified', results: [], reason: 'Unsupported function', checkIds: [] } }] } })
    wrapper = mount(CallerWorkspace)
    await button('载入迁移示例').trigger('click')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('需要人工复核')
    expect(wrapper.text()).toContain('Dynamic request URL')
    expect(wrapper.text()).toContain('未完成验证')
  })
  it('ignores a late create response after opening another saved record', async () => {
    let resolveCreate!: (value: CallerRecord) => void
    api.createCallerReview.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve }))
    const older = { ...saved, id: '02d07af3-ab3a-48fe-813d-80b271a5f92b' }
    api.getCallerReview.mockResolvedValue(older)
    api.listCallerReviews.mockResolvedValue([{ ...older, gate: 'blocked', summary: saved.report.summary }])
    wrapper = mount(CallerWorkspace)
    await flushPromises()
    await button('载入迁移示例').trigger('click')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('.caller-history li button').trigger('click')
    await flushPromises()
    resolveCreate(saved)
    await flushPromises()
    expect(wrapper.get('.caller-verdict').text()).toContain(older.id)
    expect(wrapper.get('.caller-verdict').text()).not.toContain(saved.id)
  })
  it('can open MCP-created history and reports server errors without auto retry', async () => {
    api.listCallerReviews.mockResolvedValue([{ id: saved.id, createdAt: saved.createdAt, gate: 'blocked', summary: saved.report.summary }])
    wrapper = mount(CallerWorkspace)
    await flushPromises()
    await wrapper.get('.caller-history li button').trigger('click')
    await flushPromises()
    expect(api.getCallerReview).toHaveBeenCalledWith(saved.id, expect.any(AbortSignal))
    await button('新建审查').trigger('click')
    await button('载入迁移示例').trigger('click')
    api.createCallerReview.mockRejectedValue(new Error('Caller workers are busy; retry later.'))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('workers are busy')
    expect(api.createCallerReview).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[aria-label="调用方审查报告"]').exists()).toBe(false)
  })
})
