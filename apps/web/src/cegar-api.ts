import { ApiError } from './api'

const configuredBase = import.meta.env.VITE_API_BASE?.trim() || '/api'
const API_BASE = configuredBase.replace(/\/$/, '')

export type CegarAgentMode = 'symbolic' | 'llm' | 'hybrid'

export interface CegarCallerFile {
  path: string
  content: string
}

export interface CegarRunRequestPayload {
  title?: string
  mode?: CegarAgentMode
  providerId?: string
  maxRounds?: number
  enableAdversarialFuzzing?: boolean
  baseline: unknown
  candidate: unknown
  callerFiles: CegarCallerFile[]
  testFiles: CegarCallerFile[]
  probes?: Array<{ file: string; exportName: string; args: unknown[] }>
  seedBaselineResponses?: Record<string, { status?: number; body: unknown }>
}

export interface CegarPresetItem {
  id: string
  label: string
  category: string
  description: string
  expectedRounds: number
  request: CegarRunRequestPayload
}

export interface CegarCounterexample {
  id: string
  kind: 'compiler-diagnostic' | 'request-contract-violation' | 'nominal-test-failure' | 'adversarial-witness-crash'
  file?: string
  line?: number
  column?: number
  code?: string
  witnessId?: string
  targetPath?: string
  message: string
}

export interface CegarFilePatch {
  file: string
  sourceSha256: string
  patchedSha256: string
  unifiedDiff: string
  patchedContent: string
  rationale: string
}

export interface CegarRoundRecord {
  round: number
  proposer: 'symbolic-ast' | 'llm-agent'
  actionSummary: string
  citedHypothesisIds: string[]
  citedCounterexampleIds: string[]
  patches: CegarFilePatch[]
  verification: {
    verified: boolean
    compilerClean: boolean
    nominalPassed: boolean
    requestContractPassed: boolean
    adversarialPassed: number
    adversarialTotal: number
  }
  counterexamples: CegarCounterexample[]
  durationMs: number
}

export interface CegarRunRecord {
  id: string
  title: string
  createdAt: string
  mode: CegarAgentMode
  maxRounds: number
  enableAdversarialFuzzing: boolean
  releaseGate: 'pass' | 'review' | 'blocked'
  callerImpactStatus:
    | 'unreachable-breaking-safe'
    | 'regression-repaired-verified'
    | 'regression-unresolved'
    | 'compatible-verified'
  patchStatus: 'not-needed' | 'verified' | 'failed'
  alignment: {
    hypotheses: Array<{
      id: string
      kind: string
      operation: { method: string; path: string }
      fromPath?: string
      toPath?: string
      coercionHint?: string
      confidence: number
      rationale: string
    }>
  }
  dataflow: {
    slices: Array<{
      file: string
      declarations: string[]
      slicedCode: string
      fullChars: number
      slicedChars: number
    }>
    metrics: {
      totalFiles: number
      impactedFiles: number
      fullTokensApprox: number
      slicedTokensApprox: number
      compressionRatio: number
    }
    reachability: {
      staticBreakingCount: number
      reachableBreakingChangeIds: string[]
      unreachableBreakingChangeIds: string[]
      hasUncalledBreakingOnly: boolean
    }
  }
  witnesses: {
    operations: number
    adversarialCount: number
    suites: Array<{
      operation: { method: string; path: string }
      adversarial: Array<{ id: string; kind: string; targetPath?: string; description: string }>
    }>
  }
  rounds: CegarRoundRecord[]
  finalPatches: CegarFilePatch[]
  llmCalls: number
  durationMs: number
  summary: string
}

export interface CegarRunSummary {
  id: string
  title: string
  createdAt: string
  mode: CegarAgentMode
  releaseGate: 'pass' | 'review' | 'blocked'
  callerImpactStatus: CegarRunRecord['callerImpactStatus']
  patchStatus: CegarRunRecord['patchStatus']
  rounds: number
  adversarialCount: number
  durationMs: number
}

export interface CegarStatusInfo {
  service: string
  modes: CegarAgentMode[]
  gates: string[]
  llm: {
    available: boolean
    activeProfile: string
    providers: Array<{ id: string; label: string; available: boolean; model: string }>
  }
}

async function fetchCegar<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}/cegar${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    let message = `请求失败（HTTP ${response.status}）`
    try {
      const body = (await response.json()) as { error?: { message?: string }; message?: string }
      message = body.error?.message || body.message || message
    } catch {
      // ignore
    }
    throw new ApiError(message, response.status)
  }
  return (await response.json()) as T
}

export async function getCegarStatus(): Promise<CegarStatusInfo> {
  return fetchCegar<CegarStatusInfo>('/status')
}

export async function listCegarPresets(): Promise<CegarPresetItem[]> {
  const res = await fetchCegar<{ presets: CegarPresetItem[] }>('/presets')
  return res.presets
}

export async function listCegarRuns(): Promise<CegarRunSummary[]> {
  const res = await fetchCegar<{ runs: CegarRunSummary[] }>('/runs')
  return res.runs
}

export async function getCegarRun(id: string): Promise<CegarRunRecord> {
  return fetchCegar<CegarRunRecord>(`/runs/${encodeURIComponent(id)}`)
}

export async function startCegarRun(payload: CegarRunRequestPayload, signal?: AbortSignal): Promise<CegarRunRecord> {
  return fetchCegar<CegarRunRecord>('/runs', {
    method: 'POST',
    body: JSON.stringify(payload),
    signal,
  })
}

export async function downloadCegarReport(id: string, format: 'markdown' | 'json'): Promise<void> {
  const response = await fetch(`${API_BASE}/cegar/runs/${encodeURIComponent(id)}/report?format=${format}`)
  if (!response.ok) throw new ApiError(`导出失败（HTTP ${response.status}）`, response.status)
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `contractguard-cegar-${id}.${format === 'markdown' ? 'md' : 'json'}`
  anchor.click()
  URL.revokeObjectURL(url)
}
