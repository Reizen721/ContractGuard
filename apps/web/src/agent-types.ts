import type { AnalysisCoverage, AnalysisSummary, ChangeRecord, ConsumerImpactReport, ContentFingerprint, ContractBundleInput } from './types'
import type { CallerImpactInput, CallerImpactReport } from '@contractguard/caller'
import type { ProjectTestReport, ProjectMetadata } from '@contractguard/project'

export type AgentMode = 'workflow' | 'llm'
export type AgentRunState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export interface AgentInput {
  baseline: string | ContractBundleInput | Record<string, unknown>
  candidate: string | ContractBundleInput | Record<string, unknown>
  baselineName?: string
  candidateName?: string
  consumerEvidence?: Record<string, unknown>
  caller?: Pick<CallerImpactInput, 'files' | 'scenarios' | 'fieldRenames'>
}
export type AgentSubmission = AgentInput | { projectId: string }
export interface AgentProject { id: string; label: string; testsEnabled: boolean; reason?: string }
export interface AgentStatus {
  schemaVersion: 1
  workflowAvailable: boolean
  llmAvailable: boolean
  engine: { available: boolean; version?: string; pinnedVersion: string; reason?: string }
  planner: { available: boolean; activeProfile?: string; allowProfileOverride: boolean; providers: Array<{ id: string; label: string; available: boolean; model: string }> }
  limits: { maxQueued: number; maxSteps: number; concurrency: number; maxDurationMs: number }
}
export interface AgentStep {
  id: string
  tool: string
  purpose: string
  status: 'running' | 'completed' | 'failed'
  startedAt: string
  finishedAt?: string
  summary: string
  evidenceIds: string[]
  exitCode?: number
  durationMs?: number
}
export interface AgentRunSummary {
  id: string
  mode: AgentMode
  status: AgentRunState
  createdAt: string
  updatedAt: string
  baselineName: string
  candidateName: string
  goal: string
  verdict: 'pass' | 'review' | 'blocked' | null
  summary: string
  plannerCalls: number
  completedSteps: number
  totalSteps: number
}
export interface AgentRun extends Omit<AgentRunSummary, 'completedSteps' | 'totalSteps'> {
  schemaVersion: 1
  providerId?: string
  engineVersion: string
  upstreamVersion?: string
  inputFingerprints: { baseline: ContentFingerprint; candidate: ContentFingerprint; consumerEvidence?: ContentFingerprint }
  steps: AgentStep[]
  coreAnalysis?: { summary: AnalysisSummary; changes: ChangeRecord[]; coverage?: AnalysisCoverage; consumerImpact?: ConsumerImpactReport }
  nativeUnavailable?: string
  project?: ProjectMetadata
  projectTests?: ProjectTestReport
  callerReview?: {
    id: string
    summary: CallerImpactReport['summary']
    gate: CallerImpactReport['gate']
    checks: Array<{ id: string; status: string; file: string; exportName: string }>
    patches: Array<{ id: string; file: string; status: string }>
  }
  upstream: { baselineValid?: boolean; candidateValid?: boolean; validationErrors: number; breakingCount: number; warningCount: number; findings: Array<{ id: string; source: string; ruleId: string; severity: string; message: string; operation?: string; path?: string }>; truncated: boolean }
  recommendations: Array<{ title: string; actions: string[]; evidenceIds: string[] }>
  limitations: string[]
  error?: { code: string; message: string }
}
