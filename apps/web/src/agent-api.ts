import type { AgentSubmission, AgentProject, AgentMode, AgentRun, AgentRunSummary, AgentStatus } from './agent-types'

const base = (import.meta.env.VITE_API_BASE?.trim() || '/api').replace(/\/$/, '')
async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${base}/agent${path}`, { ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } })
  if (!response.ok) {
    let message = `任务请求失败（HTTP ${response.status}）`
    try {
      const body = await response.json() as { message?: string; error?: string | { message?: string } }
      message = body.message || (typeof body.error === 'string' ? body.error : body.error?.message) || message
    } catch { /* Keep the HTTP status when the service returns a non-JSON error. */ }
    throw new Error(message)
  }
  return response.json()
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function run(value: unknown): AgentRun {
  if (!object(value) || typeof value.id !== 'string' || !['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(String(value.status)) || !Array.isArray(value.steps) || !object(value.upstream) || !Array.isArray(value.upstream.findings) || !Array.isArray(value.recommendations) || !Array.isArray(value.limitations)) throw new Error('任务记录格式异常，请刷新或查看服务日志。')
  return value as unknown as AgentRun
}
export async function getAgentStatus(signal?: AbortSignal): Promise<AgentStatus> {
  const value = await request('/status', { signal })
  if (!object(value) || !object(value.engine) || !object(value.planner) || !Array.isArray(value.planner.providers) || !object(value.limits)) throw new Error('无法读取 Agent 服务状态。')
  return value as unknown as AgentStatus
}
export async function listAgentRuns(signal?: AbortSignal): Promise<AgentRunSummary[]> {
  const value = await request('/runs', { signal })
  if (!object(value) || !Array.isArray(value.runs) || !value.runs.every((item) => object(item) && typeof item.id === 'string' && typeof item.status === 'string')) throw new Error('无法读取任务列表。')
  return value.runs as AgentRunSummary[]
}
export async function listAgentProjects(signal?: AbortSignal): Promise<AgentProject[]> {
  const value = await request('/projects', { signal })
  if (!object(value) || !Array.isArray(value.projects) || !value.projects.every((item) => object(item) && typeof item.id === 'string' && typeof item.label === 'string' && typeof item.testsEnabled === 'boolean')) throw new Error('无法读取已登记项目。')
  return value.projects as AgentProject[]
}
export async function createAgentRun(input: AgentSubmission & { mode: AgentMode; goal: string; providerId?: string }, signal?: AbortSignal): Promise<AgentRun> { return run(await request('/runs', { method: 'POST', body: JSON.stringify(input), signal })) }
export async function getAgentRun(id: string, signal?: AbortSignal): Promise<AgentRun> { return run(await request(`/runs/${encodeURIComponent(id)}`, { signal })) }
export async function cancelAgentRun(id: string, signal?: AbortSignal): Promise<AgentRun> { return run(await request(`/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', signal })) }
export async function downloadAgentReport(id: string, format: 'json' | 'markdown'): Promise<void> {
  const response = await fetch(`${base}/agent/runs/${encodeURIComponent(id)}/report?format=${format}`)
  if (!response.ok) throw new Error(`报告下载失败（HTTP ${response.status}）`)
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = `contractguard-agent-${id}.${format === 'markdown' ? 'md' : 'json'}`
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
