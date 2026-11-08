export type Severity = 'breaking' | 'potentially-breaking' | 'non-breaking' | 'info'

export interface ChangeRecord {
  id: string
  ruleId: string
  severity: Severity
  category: string
  location: string
  message: string
  before?: unknown
  after?: unknown
  recommendation?: string
  sourceLocations?: { old?: ContractSourceLocation; new?: ContractSourceLocation }
}

export interface ContractSourceLocation {
  file: string
  pointer: string
}

export interface ContractFile {
  path: string
  content: string
}

export interface ContractBundleInput {
  kind: 'bundle'
  entry: string
  files: ContractFile[]
}

export interface ContractBundleMetadata {
  entry: string
  files: Array<{ path: string; fingerprint: ContentFingerprint }>
}

export interface SourceMetadata {
  fingerprint?: ContentFingerprint
  dialect?: string
  bundle?: ContractBundleMetadata
}

export interface CoverageWarning {
  code: string
  side: 'old' | 'new'
  location: string
  message: string
  source?: ContractSourceLocation
}

export interface AnalysisCoverage {
  status: 'complete' | 'partial'
  warnings: CoverageWarning[]
  truncated: boolean
}

export interface AnalysisSummary {
  breaking: number
  potentiallyBreaking: number
  nonBreaking: number
  info: number
  total: number
}

export interface AnalysisRecord {
  id: string
  baselineName: string
  candidateName: string
  baselineVersion?: string
  candidateVersion?: string
  createdAt: string
  score: number
  compatible: boolean
  summary: AnalysisSummary
  changes: ChangeRecord[]
  engineVersion?: string
  source?: {
    old: SourceMetadata
    new: SourceMetadata
  }
  policy?: { id: string; fingerprint?: ContentFingerprint }
  coverage?: AnalysisCoverage
  consumerImpact?: ConsumerImpactReport
  /** Compact history projection; independent of the static score and compatible flag. */
  consumerGate?: ConsumerImpactReport['gate']
  consumerSummary?: ConsumerImpactReport['summary']
  /** Invalid or unsupported saved evidence is never displayed as a pass. */
  consumerImpactError?: string
}

export interface EvidenceValidation {
  status: 'valid' | 'invalid' | 'unknown'
  issues: Array<{ code: string; path: string; message: string }>
  truncated: boolean
}

export interface ConsumerCheck {
  id: string
  interactionId: string
  name: string
  kind: 'request' | 'response'
  method: string
  path: string
  status: 'pass' | 'regression' | 'invalid-baseline' | 'inconclusive'
  baseline: EvidenceValidation
  candidate: EvidenceValidation
  relatedChangeIds: string[]
  note: string
}

export interface ConsumerImpactReport {
  schemaVersion: 1
  evidenceKind: 'supplied-examples'
  fingerprint: ContentFingerprint
  summary: { consumers: number; interactions: number; checks: number; passed: number; regressions: number; invalidBaselines: number; inconclusive: number }
  gate: 'pass' | 'review' | 'blocked'
  consumers: Array<{ id: string; name: string; owner?: string; criticality: 'critical' | 'standard'; checks: ConsumerCheck[] }>
  unmappedChangeIds: string[]
  migrationTasks: Array<{ id: string; consumerId: string; owner?: string; priority: 'high' | 'normal'; checkIds: string[]; changeIds: string[]; action: string; verification: string }>
  limitations: string[]
}

export interface ContentFingerprint {
  algorithm: 'sha256'
  value: string
}

export interface RuleDefinition {
  id: string
  title: string
  description: string
  severity: Severity
  category?: string
  direction?: string
}

export type AiRiskLevel = 'critical' | 'high' | 'medium' | 'low'
export type AiRiskPriority = 'P0' | 'P1' | 'P2'

export interface AiProviderStatus {
  id: string
  displayName: string
  provider: string
  model: string
  enabled: boolean
  configured: boolean
  available: boolean
  local?: boolean
  reason?: string
}

export interface AiServiceStatus {
  enabled: boolean
  configured: boolean
  available: boolean
  provider: string
  model: string
  reason?: string
  activeProviderId?: string
  defaultProviderId?: string
  allowRequestProviderOverride: boolean
  providers: AiProviderStatus[]
  promptVersion?: string
}

export interface AiReportOverview {
  headline: string
  executiveSummary: string
  riskLevel: AiRiskLevel
}

export interface AiKeyRisk {
  changeId: string
  title: string
  explanation: string
  affectedConsumers: string[]
  remediation: string
  priority: AiRiskPriority
}

export interface AiMigrationStep {
  order: number
  title: string
  actions: string[]
  relatedChangeIds: string[]
}

export interface AiTestSuggestion {
  title: string
  details: string
  relatedChangeIds: string[]
}

export interface AiTokenUsage {
  promptTokens?: number
  completionTokens?: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export interface AiReviewReport {
  id?: string
  language?: 'zh-CN' | 'en'
  focus?: string
  schemaVersion: '1.0'
  analysisId: string
  provider: string
  providerId?: string
  providerLabel?: string
  model: string
  generatedAt: string
  promptVersion: string
  overview: AiReportOverview
  keyRisks: AiKeyRisk[]
  migrationPlan: AiMigrationStep[]
  testSuggestions: AiTestSuggestion[]
  caveats: string[]
  usage?: AiTokenUsage
  coverage?: {
    totalFindings: number
    includedFindings: number
    omittedFindings: number
    includedChangeIds: string[]
  }
}

export type ViewName = 'analyze' | 'history' | 'agent' | 'callers' | 'cegar'
export type SeverityFilter = 'all' | Severity
export type ExportFormat = 'json' | 'markdown' | 'html'
