import type { ContentFingerprint } from './types.js';

export type EvidenceStatus = 'valid' | 'invalid' | 'unknown';
export interface EvidenceIssue { code: string; path: string; message: string }
export interface EvidenceValidation { status: EvidenceStatus; issues: EvidenceIssue[]; truncated: boolean }
export interface ConsumerRequestExample {
  /** Decoded parameter values; this does not test HTTP serialization. */
  parameters?: Partial<Record<'path' | 'query' | 'header' | 'cookie', Record<string, unknown>>>;
  mediaType?: string;
  body?: unknown;
}
export interface ConsumerResponseExample {
  status: string;
  mediaType: string;
  baselineBody: unknown;
  /** Omission means no candidate evidence, never a passing result. */
  candidateBody?: unknown;
  /** Consumer-owned JSON Schema assertion, independent of the provider schema. */
  expectation: boolean | Record<string, unknown>;
}
export interface ConsumerInteraction {
  id: string;
  name?: string;
  method: string;
  /** Exact OpenAPI path template, not a URL or a guessed route match. */
  path: string;
  request?: ConsumerRequestExample;
  response?: ConsumerResponseExample;
}
export interface ConsumerEvidence {
  schemaVersion: 1;
  consumers: Array<{
    id: string;
    name: string;
    owner?: string;
    criticality: 'critical' | 'standard';
    interactions: ConsumerInteraction[];
  }>;
}
export type ConsumerCheckStatus = 'pass' | 'regression' | 'invalid-baseline' | 'inconclusive';
export interface ConsumerCheck {
  id: string;
  interactionId: string;
  name: string;
  kind: 'request' | 'response';
  method: string;
  path: string;
  status: ConsumerCheckStatus;
  baseline: EvidenceValidation;
  candidate: EvidenceValidation;
  /** Operation-level context, not a claim that every linked change caused this check to fail. */
  relatedChangeIds: string[];
  note: string;
}
export interface ConsumerImpactReport {
  schemaVersion: 1;
  evidenceKind: 'supplied-examples';
  fingerprint: ContentFingerprint;
  summary: { consumers: number; interactions: number; checks: number; passed: number; regressions: number; invalidBaselines: number; inconclusive: number };
  gate: 'pass' | 'review' | 'blocked';
  consumers: Array<{
    id: string;
    name: string;
    owner?: string;
    criticality: 'critical' | 'standard';
    checks: ConsumerCheck[];
  }>;
  /** Risk findings with no operation-level consumer evidence. Not proof of unused endpoints. */
  unmappedChangeIds: string[];
  migrationTasks: Array<{
    id: string;
    consumerId: string;
    owner?: string;
    priority: 'high' | 'normal';
    checkIds: string[];
    changeIds: string[];
    action: string;
    verification: string;
  }>;
  limitations: string[];
}
