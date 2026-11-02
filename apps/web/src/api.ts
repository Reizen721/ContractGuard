import type { AiReviewReport, AiServiceStatus, AnalysisRecord, ContractBundleInput, ExportFormat, RuleDefinition } from './types'
import {
  normalizeAiReview,
  normalizeAiStatus,
  normalizeAnalysis,
  normalizeAnalysisList,
  normalizeRules,
} from './utils'

const configuredBase = import.meta.env.VITE_API_BASE?.trim() || '/api'
const API_BASE = configuredBase.replace(/\/$/, '')

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (!response.ok) {
    let message = `请求失败（HTTP ${response.status}）`
    try {
      const body = (await response.json()) as {
        message?: string
        error?: string | { message?: string }
      }
      message =
        body.message ||
        (typeof body.error === 'string' ? body.error : body.error?.message) ||
        message
    } catch {
      // A non-JSON error response still receives a useful HTTP fallback.
    }
    throw new ApiError(message, response.status)
  }

  if (response.status === 204) return undefined
  return response.json()
}

export async function checkHealth(): Promise<boolean> {
  try {
    await request('/health')
    return true
  } catch {
    return false
  }
}

export async function createAnalysis(input: {
  baseline: string | ContractBundleInput
  candidate: string | ContractBundleInput
  baselineName?: string
  candidateName?: string
  consumerEvidence?: Record<string, unknown>
}, signal?: AbortSignal): Promise<AnalysisRecord> {
  const result = await request('/analyses', {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  })
  return normalizeAnalysis(result)
}

export async function listAnalyses(): Promise<AnalysisRecord[]> {
  return normalizeAnalysisList(await request('/analyses'))
}

export async function getAnalysis(id: string, signal?: AbortSignal): Promise<AnalysisRecord> {
  return normalizeAnalysis(await request(`/analyses/${encodeURIComponent(id)}`, { signal }))
}

export async function deleteAnalysis(id: string): Promise<void> {
  await request(`/analyses/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function listRules(): Promise<RuleDefinition[]> {
  return normalizeRules(await request('/rules'))
}

export async function getAiStatus(signal?: AbortSignal): Promise<AiServiceStatus> {
  return normalizeAiStatus(await request('/ai/status', { signal }))
}

export async function generateAiReview(
  analysisId: string,
  input: { language: 'zh-CN'; focus?: string; providerId?: string; force?: boolean },
  signal?: AbortSignal,
): Promise<AiReviewReport> {
  const result = await request(`/analyses/${encodeURIComponent(analysisId)}/ai-review`, {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  })
  return normalizeAiReview(result)
}

export async function listAiReviews(analysisId: string, signal?: AbortSignal): Promise<AiReviewReport[]> {
  const value = await request(`/analyses/${encodeURIComponent(analysisId)}/ai-reviews`, { signal }) as { reviews?: unknown[] }
  return Array.isArray(value.reviews) ? value.reviews.map(normalizeAiReview) : []
}

export async function downloadAiReview(report: AiReviewReport, format: 'json' | 'markdown'): Promise<void> {
  if (!report.id) throw new Error('此旧版解读尚未保存，请重新生成后导出。')
  const response = await fetch(`${API_BASE}/analyses/${encodeURIComponent(report.analysisId)}/ai-reviews/${encodeURIComponent(report.id)}/report?format=${format}`)
  if (!response.ok) throw new ApiError(`AI 解读导出失败（HTTP ${response.status}）`, response.status)
  downloadBlob(await response.blob(), `contractguard-ai-${report.id}.${extensionFor(format)}`)
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function extensionFor(format: ExportFormat): string {
  return format === 'markdown' ? 'md' : format
}

export async function downloadReport(
  analysis: AnalysisRecord,
  format: ExportFormat,
): Promise<void> {
  const response = await fetch(
    `${API_BASE}/analyses/${encodeURIComponent(analysis.id)}/report?format=${encodeURIComponent(format)}`,
  )
  if (!response.ok) throw new ApiError(`报告导出失败（HTTP ${response.status}）`, response.status)
  downloadBlob(await response.blob(), `contractguard-${analysis.id}.${extensionFor(format)}`)
}
