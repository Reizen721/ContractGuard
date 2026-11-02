import type { AnalysisResult, OpenApiInput } from '@contractguard/core';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface CallerFile { path: string; content: string }
export interface CallerOperation { method: string; path: string }
export interface CallerResponse { status: number; body: JsonValue }
export interface CallerScenario {
  id: string;
  file: string;
  exportName: string;
  args: JsonValue[];
  operation: CallerOperation;
  baselineResponse: CallerResponse;
  candidateResponse: CallerResponse;
  /** Explicit output oracle; changed data alone must not be inferred to be a regression. */
  expected: JsonValue;
}
export interface CallerFieldRename extends CallerOperation { from: string; to: string }
export interface CallerImpactInput {
  schemaVersion: 1;
  baseline: OpenApiInput;
  candidate: OpenApiInput;
  files: CallerFile[];
  scenarios: CallerScenario[];
  /** Operator-supplied top-level response property mappings, never inferred as semantic equivalence. */
  fieldRenames?: CallerFieldRename[];
}
export interface CallerFieldUsage { path: string; line: number; column: number; start: number; end: number }
export interface CallerCallsite {
  id: string; file: string; line: number; column: number; exportName: string;
  client: 'fetch' | 'axios'; method: string | null; path: string | null;
  status: 'resolved' | 'unknown'; reason?: string;
  fields: CallerFieldUsage[]; relatedChangeIds: string[];
}
export interface CallerReplayOutcome {
  status: 'passed' | 'failed' | 'unsupported';
  value?: JsonValue;
  error?: string;
  steps: number;
  requests: number;
}
export interface CallerCheck {
  id: string; scenarioId: string; file: string; exportName: string;
  operation: CallerOperation;
  status: 'pass' | 'regression' | 'invalid-baseline' | 'inconclusive';
  baseline: CallerReplayOutcome;
  candidate: CallerReplayOutcome;
  callsiteIds: string[];
  note: string;
}
export interface CallerPatchEdit { start: number; end: number; before: string; after: string }
export interface CallerPatch {
  id: string; file: string; sourceSha256: string; patchedSha256: string;
  edits: CallerPatchEdit[]; unifiedDiff: string; patchedContent: string;
  verification: {
    status: 'verified' | 'failed' | 'unverified';
    checkIds: string[];
    results: Array<{ scenarioId: string; outcome: CallerReplayOutcome }>;
    reason: string;
  };
}
export interface CallerImpactReport {
  schemaVersion: 1;
  toolVersion: string;
  generatedAt: string;
  evidenceKind: 'bounded-typescript-replay';
  inputFingerprint: { algorithm: 'sha256'; value: string };
  sourceFiles: Array<{ path: string; sha256: string }>;
  contractAnalysis: AnalysisResult;
  callsites: CallerCallsite[];
  checks: CallerCheck[];
  patches: CallerPatch[];
  summary: {
    files: number; callsites: number; resolved: number; unknown: number;
    checks: number; passed: number; regressions: number; invalidBaselines: number;
    inconclusive: number; verifiedPatches: number;
  };
  gate: 'pass' | 'review' | 'blocked';
  limitations: string[];
}
