import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentWorkspace from './components/AgentWorkspace.vue'
import type { AgentInput, AgentRun, AgentRunSummary, AgentStatus } from './agent-types'

const api = vi.hoisted(() => ({ getAgentStatus: vi.fn(), listAgentProjects: vi.fn(), listAgentRuns: vi.fn(), createAgentRun: vi.fn(), getAgentRun: vi.fn(), cancelAgentRun: vi.fn(), downloadAgentReport: vi.fn() }))
vi.mock('./agent-api', () => api)
const input: AgentInput = { baseline: 'old spec', candidate: 'new spec', baselineName: 'old.yaml', candidateName: 'new.yaml', consumerEvidence: { schemaVersion: 1, consumers: [] } }
const service: AgentStatus = { schemaVersion: 1, workflowAvailable: true, llmAvailable: false, engine: { available: true, version: '1.35.0', pinnedVersion: '1.35.0' }, planner: { available: false, activeProfile: 'deepseek', allowProfileOverride: true, providers: [{ id: 'deepseek', label: 'DeepSeek', available: true, model: 'deepseek-chat' }] }, limits: { maxQueued: 5, maxSteps: 7, concurrency: 1, maxDurationMs: 180000 } }
function run(id = 'task-a', status: AgentRun['status'] = 'running'): AgentRun {
  return { schemaVersion: 1, id, mode: 'workflow', status, createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', baselineName: 'old.yaml', candidateName: `${id}.yaml`, goal: 'Check release', verdict: null, summary: '', plannerCalls: 0, engineVersion: '1.5.0', inputFingerprints: { baseline: { algorithm: 'sha256', value: 'a'.repeat(64) }, candidate: { algorithm: 'sha256', value: 'b'.repeat(64) } }, steps: [{ id: 'STEP-01', tool: 'validate-baseline', purpose: 'Validate baseline', status: 'completed', startedAt: '2026-11-02T00:00:00Z', summary: 'Valid', evidenceIds: [] }], upstream: { validationErrors: 0, breakingCount: 0, warningCount: 0, findings: [], truncated: false }, recommendations: [], limitations: [] }
}
function summary(id: string): AgentRunSummary { return { ...run(id), completedSteps: 1, totalSteps: 5 } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes }); return { promise, resolve } }
function button(page: VueWrapper, text: string) { const result = page.findAll('button').find((item) => item.text() === text); if (!result) throw new Error(`Missing button ${text}`); return result }
let wrapper: VueWrapper | undefined
beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  localStorage.clear()
  api.getAgentStatus.mockResolvedValue(structuredClone(service))
  api.listAgentRuns.mockResolvedValue([])
  api.listAgentProjects.mockResolvedValue([])
  api.createAgentRun.mockResolvedValue(run())
  api.getAgentRun.mockResolvedValue(run())
  api.cancelAgentRun.mockResolvedValue(run('task-a', 'cancelled'))
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.useRealTimers() })
async function page(props: { input: AgentInput | null; inputIssue: string } = { input, inputIssue: '' }) { wrapper = mount(AgentWorkspace, { props }); await flushPromises(); return wrapper }

describe('Agent workspace lifecycle and evidence', () => {
  it('runs a registered project without requiring editor input or sending a server path', async () => {
    api.listAgentProjects.mockResolvedValue([{ id: 'orders-local', label: 'Orders tests', testsEnabled: true }])
    const view = await page({ input: null, inputIssue: 'Missing editor specs' })
    await view.find('select').setValue('project')
    await view.findAll('select')[1]!.setValue('orders-local')
    await view.find('form').trigger('submit')
    await flushPromises()
    expect(api.createAgentRun.mock.calls[0]![0]).toMatchObject({ projectId: 'orders-local', mode: 'workflow' })
    expect(api.createAgentRun.mock.calls[0]![0]).not.toHaveProperty('baseline')
    expect(api.createAgentRun.mock.calls[0]![0]).not.toHaveProperty('root')
  })

  it('clears a stale project selection when refreshing the registry fails', async () => {
    api.listAgentProjects.mockResolvedValueOnce([{ id: 'orders-local', label: 'Orders tests', testsEnabled: true }])
    const view = await page()
    await view.find('select').setValue('project')
    await view.findAll('select')[1]!.setValue('orders-local')
    api.listAgentProjects.mockRejectedValueOnce(new Error('Registry unavailable'))
    await button(view, '刷新项目').trigger('click')
    await flushPromises()
    expect(button(view, '开始审查').attributes('disabled')).toBeDefined()
    expect(view.text()).toContain('Registry unavailable')
    expect(api.createAgentRun).not.toHaveBeenCalled()
  })

  it('submits the migration bundle with the exact contracts and source evidence', async () => {
    const view = await page({ input: null, inputIssue: '' })
    await view.find('select').setValue('migration')
    await button(view, '使用调用方迁移示例').trigger('click')
    await view.find('form').trigger('submit')
    await flushPromises()
    const submitted = api.createAgentRun.mock.calls[0]![0]
    expect(submitted.caller.files).toHaveLength(2)
    expect(submitted.caller.scenarios).toHaveLength(3)
    expect(submitted.caller.fieldRenames).toHaveLength(2)
    expect(submitted.baseline.openapi).toBe('3.1.0')
    expect(submitted).not.toHaveProperty('projectId')
  })

  it('shows real project test failures without clearing the contract gate and links caller history', async () => {
    const phase = { status: 'passed', exitCode: 0, tests: { total: 3, passed: 3, failed: 0, skipped: 0 }, durationMs: 30, output: 'Existing tests executed', truncated: false }
    const record = { ...run('project-run', 'completed'), verdict: 'blocked', callerReview: { id: 'caller-saved-id', summary: { files: 2, regressions: 2, inconclusive: 0, verifiedPatches: 2 }, checks: [], patches: [] }, projectTests: { schemaVersion: 1, evidenceKind: 'project-test-execution', projectId: 'orders-local', snapshotFingerprint: { algorithm: 'sha256', value: 'a'.repeat(64) }, runner: 'node-test', testFiles: ['test/orders.test.mjs'], baseline: phase, candidate: { ...phase, status: 'failed', exitCode: 1, tests: { total: 3, passed: 1, failed: 2, skipped: 0 } }, patched: phase, status: 'regression', patchStatus: 'verified', patchIds: ['PATCH-0001'], limitations: [] } }
    localStorage.setItem('contractguard.agent.last-run', 'project-run')
    api.getAgentRun.mockResolvedValue(record)
    const view = await page()
    expect(view.find('.project-test-evidence').text()).toContain('候选引入测试回归')
    expect(view.find('.project-test-evidence').text()).toContain('已通过项目测试')
    expect(view.find('.agent-verdict').text()).toContain('发现阻断项')
    await button(view, '查看源码位置与补丁').trigger('click')
    expect(view.emitted('openCaller')).toEqual([['caller-saved-id']])
  })

  it('requires valid workspace inputs and keeps unavailable LLM mode disabled', async () => {
    const view = await page({ input: null, inputIssue: 'Please load both specs' })
    expect(button(view, '开始审查').attributes('disabled')).toBeDefined()
    expect(view.find('input[value="llm"]').attributes('disabled')).toBeDefined()
    expect(view.text()).toContain('Please load both specs')
    await button(view, '前往输入').trigger('click')
    expect(view.emitted('edit')).toHaveLength(1)
    expect(api.createAgentRun).not.toHaveBeenCalled()
  })

  it('submits a workflow snapshot with evidence and never implicitly uses a model', async () => {
    const view = await page()
    await view.find('form').trigger('submit')
    await flushPromises()
    const submitted = api.createAgentRun.mock.calls[0]![0]
    expect(submitted).toMatchObject({ ...input, mode: 'workflow' })
    expect(submitted.providerId).toBeUndefined()
    expect(submitted.consumerEvidence).not.toBe(input.consumerEvidence)
    await view.setProps({ input: { ...input, candidateName: 'later-editor.yaml' } })
    expect(view.find('.agent-run-heading').text()).toContain('task-a.yaml')
    expect(view.find('.agent-run-heading').text()).not.toContain('later-editor.yaml')
    expect(localStorage.getItem('contractguard.agent.last-run')).toBe('task-a')
  })

  it('does not keep a stale available status after a failed service refresh', async () => {
    const view = await page()
    expect(button(view, '开始审查').attributes('disabled')).toBeUndefined()
    api.getAgentStatus.mockRejectedValueOnce(new Error('status offline'))
    await button(view, '重新检测').trigger('click')
    await flushPromises()
    expect(view.find('.engine-strip').text()).toContain('status offline')
    expect(button(view, '开始审查').attributes('disabled')).toBeDefined()
    await button(view, '重新检测').trigger('click')
    await flushPromises()
    expect(view.find('.engine-strip').text()).not.toContain('status offline')
    expect(button(view, '开始审查').attributes('disabled')).toBeUndefined()
  })

  it('requires explicit model selection and discloses cloud summary sharing', async () => {
    api.getAgentStatus.mockResolvedValue({ ...service, llmAvailable: true, planner: { ...service.planner, available: true } })
    const view = await page()
    expect(view.find('.cloud-disclosure').exists()).toBe(false)
    await view.find('input[value="llm"]').setValue()
    expect(view.find('.cloud-disclosure').text()).toContain('任务目标、检查摘要和证据编号')
    await view.find('form').trigger('submit')
    await flushPromises()
    expect(api.createAgentRun.mock.calls[0]![0]).toMatchObject({ mode: 'llm', providerId: 'deepseek' })
  })

  it('cancels a running task and stops polling its terminal record', async () => {
    const view = await page()
    await view.find('form').trigger('submit')
    await flushPromises()
    await button(view, '取消任务').trigger('click')
    await flushPromises()
    expect(api.cancelAgentRun).toHaveBeenCalledWith('task-a', expect.any(AbortSignal))
    expect(view.find('.agent-run-heading').text()).toContain('已取消')
    await vi.advanceTimersByTimeAsync(10000)
    expect(api.getAgentRun).not.toHaveBeenCalled()
  })

  it('pauses on a polling error and lets the user explicitly resume', async () => {
    const view = await page()
    await view.find('form').trigger('submit')
    await flushPromises()
    api.getAgentRun.mockRejectedValueOnce(new Error('offline'))
    await vi.advanceTimersByTimeAsync(1500)
    expect(view.text()).toContain('状态更新已暂停：offline')
    await vi.advanceTimersByTimeAsync(10000)
    expect(api.getAgentRun).toHaveBeenCalledTimes(1)
    api.getAgentRun.mockResolvedValue({ ...run('task-a', 'completed'), verdict: 'blocked', summary: 'Deterministic failure' })
    await button(view, '重新获取状态').trigger('click')
    await flushPromises()
    expect(view.find('.agent-verdict').text()).toContain('发现阻断项')
    expect(view.text()).not.toContain('自动刷新已暂停')
  })

  it('discards a late poll after selecting a different saved task', async () => {
    const pending = deferred<AgentRun>()
    api.listAgentRuns.mockResolvedValue([summary('task-b')])
    const view = await page()
    await view.find('form').trigger('submit')
    await flushPromises()
    api.getAgentRun.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(run('task-b', 'completed'))
    await vi.advanceTimersByTimeAsync(1500)
    const signal = api.getAgentRun.mock.calls[0]![1] as AbortSignal
    const saved = view.findAll('.agent-history button').find((item) => item.text().includes('task-b.yaml'))!
    await saved.trigger('click')
    await flushPromises()
    expect(signal.aborted).toBe(true)
    pending.resolve({ ...run('task-a', 'completed'), summary: 'Outdated response' })
    await flushPromises()
    expect(view.find('.agent-run-heading').text()).toContain('task-b.yaml')
    expect(view.text()).not.toContain('Outdated response')
  })

  it('aborts pending reads on unmount and does not schedule another poll', async () => {
    const pending = deferred<AgentRun>()
    const view = await page()
    await view.find('form').trigger('submit')
    await flushPromises()
    api.getAgentRun.mockReturnValue(pending.promise)
    await vi.advanceTimersByTimeAsync(1500)
    const signal = api.getAgentRun.mock.calls[0]![1] as AbortSignal
    view.unmount(); wrapper = undefined
    expect(signal.aborted).toBe(true)
    pending.resolve(run())
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10000)
    expect(api.getAgentRun).toHaveBeenCalledTimes(1)
  })

  it('restores a saved task and keeps evidence validity separate from generated advice', async () => {
    localStorage.setItem('contractguard.agent.last-run', 'task-a')
    api.getAgentRun.mockResolvedValue({ ...run('task-a', 'completed'), mode: 'llm', verdict: 'blocked', recommendations: [{ title: 'Generated advice', actions: ['Verify consumer'], evidenceIds: ['STEP-01', 'missing-evidence'] }] })
    const view = await page()
    expect(api.getAgentRun).toHaveBeenCalledWith('task-a', expect.any(AbortSignal))
    expect(view.find('.agent-verdict').text()).toContain('发现阻断项')
    expect(view.find('.agent-recommendations').text()).toContain('模型建议 · 需人工确认')
    const evidence = view.findAll('.agent-recommendations code')
    expect(evidence[0]!.text()).toBe('STEP-01')
    expect(evidence[1]!.text()).toContain('未找到对应证据')
    await button(view, '导出 Markdown').trigger('click')
    expect(api.downloadAgentReport).toHaveBeenCalledWith('task-a', 'markdown')
  })

  it('bounds automatic polling even when the service never finishes', async () => {
    api.getAgentStatus.mockResolvedValue({ ...service, limits: { ...service.limits, maxDurationMs: 1 } })
    const view = await page()
    await view.find('form').trigger('submit')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(33000)
    expect(view.text()).toContain('自动刷新已暂停')
    const calls = api.getAgentRun.mock.calls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(api.getAgentRun).toHaveBeenCalledTimes(calls)
  })
})
