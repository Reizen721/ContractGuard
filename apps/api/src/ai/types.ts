import type { StoredAnalysis } from '../types.js';

export type AiReviewLanguage = 'zh-CN' | 'en';
export type AiRiskLevel = 'critical' | 'high' | 'medium' | 'low';
export type AiRiskPriority = 'P0' | 'P1' | 'P2';

export interface AiReviewRequest {
  language: AiReviewLanguage;
  focus?: string;
  /** Server-configured profile identifier. Clients can never supply a URL, model, or credential. */
  providerId?: string;
  /** Explicitly generate a fresh review instead of reusing a saved result. */
  force?: boolean;
}

export interface AiReviewCoverage {
  totalFindings: number;
  includedFindings: number;
  omittedFindings: number;
  includedChangeIds: string[];
}

export interface AiReview {
  /** Present on persisted reviews created by V1.2 and later. */
  id?: string;
  language?: AiReviewLanguage;
  focus?: string;
  coverage?: AiReviewCoverage;
  schemaVersion: '1.0';
  analysisId: string;
  provider: string;
  providerId: string;
  providerLabel: string;
  model: string;
  generatedAt: string;
  promptVersion: 'ai-explainer-v1' | 'ai-explainer-v2' | 'ai-explainer-v3' | 'ai-explainer-v4';
  overview: {
    headline: string;
    executiveSummary: string;
    riskLevel: AiRiskLevel;
  };
  keyRisks: Array<{
    changeId: string;
    title: string;
    explanation: string;
    affectedConsumers: string[];
    remediation: string;
    priority: AiRiskPriority;
  }>;
  migrationPlan: Array<{
    order: number;
    title: string;
    actions: string[];
    relatedChangeIds: string[];
  }>;
  testSuggestions: Array<{
    title: string;
    details: string;
    relatedChangeIds: string[];
  }>;
  caveats: string[];
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface AiServiceStatus {
  enabled: boolean;
  configured: boolean;
  available: boolean;
  /** Backwards-compatible alias for the active profile's provider kind. */
  provider: string;
  model: string;
  promptVersion: 'ai-explainer-v1' | 'ai-explainer-v2' | 'ai-explainer-v3' | 'ai-explainer-v4';
  activeProfile: string;
  activeProviderId: string;
  defaultProviderId: string;
  allowRequestProfileOverride: boolean;
  allowRequestProviderOverride: boolean;
  providers: AiProviderStatus[];
}

export interface AiProviderStatus {
  id: string;
  label: string;
  displayName: string;
  provider: string;
  model: string;
  enabled: boolean;
  configured: boolean;
  available: boolean;
  local: boolean;
}

export interface AiReviewService {
  status(): AiServiceStatus;
  /** Validates current provider permissions and returns a secret-free configuration identity. */
  cacheIdentity?(request: AiReviewRequest): string;
  review(analysis: StoredAnalysis, request: AiReviewRequest, options?: AiReviewCallOptions): Promise<AiReview>;
}

export interface AiReviewCallOptions {
  /** Aborts the upstream request when the caller disconnects or explicitly cancels. */
  signal?: AbortSignal;
}

export class AiServiceError extends Error {
  readonly status: 400 | 499 | 502 | 503 | 504;
  readonly code: string;

  constructor(status: 400 | 499 | 502 | 503 | 504, code: string, message: string) {
    super(message);
    this.name = 'AiServiceError';
    this.status = status;
    this.code = code;
  }
}
