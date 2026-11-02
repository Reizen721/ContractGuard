import type { AnalysisResult, ConsumerEvidence, ContentFingerprint, OpenApiInput } from '@contractguard/core';
import type { AiRuntimeConfig } from '../ai/config.js';
import type { DeepSeekAiConfig } from '../ai/deepseek.js';
import type { CallerImpactInput, CallerImpactReport } from '@contractguard/caller';
import type { ProjectMetadata, ProjectTestReport } from '@contractguard/project';

export const AGENT_TOOLS = ['validate-baseline', 'validate-candidate', 'breaking', 'changelog', 'native-analysis', 'caller-analysis', 'project-tests', 'summary', 'diff'] as const;
export type AgentTool = typeof AGENT_TOOLS[number];
export type AgentMode = 'workflow' | 'llm';
export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface AgentRunInput {
  baseline: OpenApiInput;
  candidate: OpenApiInput;
  baselineName?: string;
  candidateName?: string;
  consumerEvidence?: ConsumerEvidence;
  goal?: string;
  mode?: AgentMode;
  providerId?: string;
  caller?: Pick<CallerImpactInput, 'files' | 'scenarios' | 'fieldRenames'>;
  /** Resolved only from an operator-configured project, never an arbitrary path. */
  projectId?: string;
}
export interface AgentProjectInput { projectId: string; mode?: AgentMode; goal?: string; providerId?: string }
export interface AgentCallerReview {
  id: string; createdAt: string;
  evidenceKind: CallerImpactReport['evidenceKind']; inputFingerprint: CallerImpactReport['inputFingerprint'];
  sourceFiles: CallerImpactReport['sourceFiles']; summary: CallerImpactReport['summary']; gate: CallerImpactReport['gate'];
  checks: Array<{ id: string; sourceCheckId: string; scenarioId: string; file: string; exportName: string; status: CallerImpactReport['checks'][number]['status'] }>;
  patches: Array<{ id: string; sourcePatchId: string; file: string; status: CallerImpactReport['patches'][number]['verification']['status'] }>;
  limitations: string[];
}
export interface AgentRecommendation { title: string; actions: string[]; evidenceIds: string[] }
export interface AgentStep {
  id: string;
  tool: AgentTool;
  purpose: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  summary: string;
  evidenceIds: string[];
  exitCode?: number;
  durationMs?: number;
}
export interface AgentFinding {
  id: string;
  source: 'oasdiff';
  ruleId: string;
  fingerprint: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  operation?: string;
  path?: string;
}
export interface AgentRun {
  schemaVersion: 1;
  id: string;
  mode: AgentMode;
  status: AgentRunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  baselineName: string;
  candidateName: string;
  goal: string;
  providerId?: string;
  engineVersion: string;
  upstreamVersion?: string;
  inputFingerprints: { baseline: ContentFingerprint; candidate: ContentFingerprint; consumerEvidence?: ContentFingerprint; caller?: ContentFingerprint; project?: ContentFingerprint };
  verdict: 'pass' | 'review' | 'blocked' | null;
  steps: AgentStep[];
  coreAnalysis?: AnalysisResult;
  /** Stored for V1.8; older records use the original five required checks. */
  requiredTools?: AgentTool[];
  project?: ProjectMetadata;
  callerReview?: AgentCallerReview;
  projectTests?: ProjectTestReport;
  nativeUnavailable?: string;
  upstream: {
    baselineValid?: boolean;
    candidateValid?: boolean;
    validationErrors: number;
    breakingCount: number;
    warningCount: number;
    findings: AgentFinding[];
    truncated: boolean;
  };
  summary: string;
  recommendations: AgentRecommendation[];
  limitations: string[];
  error?: { code: string; message: string };
  /** Public action descriptions only; no chain-of-thought or raw model transcript. */
  plannerCalls: number;
}
export type AgentRunSummary = Pick<AgentRun, 'id' | 'mode' | 'status' | 'createdAt' | 'updatedAt' | 'baselineName' | 'candidateName' | 'goal' | 'verdict' | 'summary' | 'plannerCalls'> & { completedSteps: number; totalSteps: number };
export interface AgentStatus {
  schemaVersion: 1;
  workflowAvailable: boolean;
  llmAvailable: boolean;
  engine: { available: boolean; version?: string; pinnedVersion: string; reason?: string };
  planner: { available: boolean; activeProfile?: string; allowProfileOverride: boolean; providers: Array<{ id: string; label: string; available: boolean; model: string }> };
  limits: { maxQueued: number; maxSteps: number; concurrency: number; maxDurationMs: number };
}
export interface AgentDecision {
  tool: AgentTool | 'finish';
  purpose: string;
  summary?: string;
  recommendations?: AgentRecommendation[];
}
export interface AgentObservation {
  goal: string;
  availableTools: Array<AgentTool | 'finish'>;
  completedTools: AgentTool[];
  steps: Array<Pick<AgentStep, 'id' | 'tool' | 'status' | 'summary' | 'evidenceIds'>>;
  knownEvidenceIds: string[];
  evidence: Array<{ id: string; kind: string; summary: string; location?: string; relatedEvidenceIds?: string[] }>;
  limitations: string[];
  deterministicVerdict: AgentRun['verdict'];
  counts: { upstreamBreaking: number; upstreamWarnings: number; validationErrors: number; nativeBreaking: number | null; consumerRegressions: number | null; callerRegressions?: number | null; verifiedCallerPatches?: number | null; projectTestStatus?: ProjectTestReport['status'] | null };
}
export interface AgentPlanner {
  status(): AgentStatus['planner'];
  assertAvailable(providerId?: string): void;
  decide(observation: AgentObservation, options: { providerId?: string; signal: AbortSignal; onRetry?: () => Promise<void> }): Promise<AgentDecision>;
}
export interface AgentToolResult { version: string; args: string[]; exitCode: number; stdout: string; stderr: string; durationMs: number }
export interface AgentToolRunner {
  status(): Promise<AgentStatus['engine']>;
  run(command: 'validate' | 'breaking' | 'changelog' | 'summary' | 'diff', inputs: { baseline: OpenApiInput; candidate: OpenApiInput }, options: { side?: 'baseline' | 'candidate'; signal: AbortSignal }): Promise<AgentToolResult>;
}
export interface AgentOptions {
  dataDirectory: string;
  aiRuntimeConfig?: AiRuntimeConfig;
  aiConfigPath?: string;
  aiEnvironment?: NodeJS.ProcessEnv;
  aiFetch?: typeof globalThis.fetch;
  aiConfig?: Partial<DeepSeekAiConfig>;
  oasdiffPath?: string;
  planner?: AgentPlanner;
  runner?: AgentToolRunner;
  maxQueued?: number;
  projectConfigPath?: string;
  callerDataDirectory?: string;
}
