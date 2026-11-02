import type { CallerImpactReport } from '@contractguard/caller'

export interface CallerRecord { id: string; createdAt: string; report: CallerImpactReport }
export interface CallerSummary { id: string; createdAt: string; gate: CallerImpactReport['gate']; summary: CallerImpactReport['summary'] }
const base = (import.meta.env.VITE_API_BASE?.trim() || '/api').replace(/\/$/, '')

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${base}/caller-reviews${path}`, { ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } })
  if (!response.ok) {
    let message = `调用方审查请求失败（HTTP ${response.status}）`
    try {
      const body = await response.json() as { message?: string; error?: string | { message?: string } }
      message = body.message || (typeof body.error === 'string' ? body.error : body.error?.message) || message
    } catch { /* Retain the status when the response is not JSON. */ }
    throw new Error(message)
  }
  return response.json()
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function record(value: unknown): CallerRecord {
  if (!object(value) || typeof value.id !== 'string' || typeof value.createdAt !== 'string' || !object(value.report)
    || value.report.evidenceKind !== 'bounded-typescript-replay' || !object(value.report.summary)
    || !['pass', 'review', 'blocked'].includes(String(value.report.gate))
    || !Array.isArray(value.report.callsites) || !Array.isArray(value.report.checks) || !Array.isArray(value.report.patches) || !Array.isArray(value.report.limitations)) {
    throw new Error('调用方报告格式异常，请重新载入记录。')
  }
  return value as unknown as CallerRecord
}
export async function listCallerReviews(signal?: AbortSignal): Promise<CallerSummary[]> {
  const value = await request('', { signal })
  if (!object(value) || !Array.isArray(value.reviews) || !value.reviews.every((item) => object(item) && typeof item.id === 'string' && object(item.summary))) throw new Error('无法读取调用方审查历史。')
  return value.reviews as CallerSummary[]
}
export async function createCallerReview(input: unknown, signal?: AbortSignal): Promise<CallerRecord> { return record(await request('', { method: 'POST', body: JSON.stringify(input), signal })) }
export async function getCallerReview(id: string, signal?: AbortSignal): Promise<CallerRecord> { return record(await request(`/${encodeURIComponent(id)}`, { signal })) }
export async function downloadCallerReview(id: string, format: 'json' | 'markdown'): Promise<void> {
  const response = await fetch(`${base}/caller-reviews/${encodeURIComponent(id)}/report?format=${format}`)
  if (!response.ok) throw new Error(`报告下载失败（HTTP ${response.status}）`)
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = `contractguard-callers-${id}.${format === 'markdown' ? 'md' : 'json'}`
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
