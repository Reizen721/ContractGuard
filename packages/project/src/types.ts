import type { OpenApiInput } from '@contractguard/core';
import type { CallerImpactInput, CallerOperation, CallerFieldRename, JsonValue } from '@contractguard/caller';

export type ProjectRunner = 'node-test' | 'vitest';
export interface ProjectSummary { id: string; label: string; testsEnabled: true; runner: ProjectRunner }
export interface ProjectMetadata {
  id: string; label: string; runner: ProjectRunner; testFiles: string[];
  snapshotFingerprint: { algorithm: 'sha256'; value: string };
  sourceFiles: Array<{ path: string; sha256: string }>;
}
export interface PreparedProject { metadata: ProjectMetadata; baseline: OpenApiInput; candidate: OpenApiInput; caller?: CallerImpactInput }
export interface ProjectPhase {
  status: 'passed' | 'failed' | 'inconclusive' | 'cancelled'; exitCode: number | null;
  tests: { passed: number; failed: number; skipped: number; total: number };
  durationMs: number; output: string; truncated: boolean; reason?: string;
  /** Stable hash of the executed test identities and their skipped/executed status. */
  testIdentityHash?: string;
}
export interface ProjectTestReport {
  schemaVersion: 1; evidenceKind: 'project-test-execution'; projectId: string;
  snapshotFingerprint: ProjectMetadata['snapshotFingerprint']; runner: ProjectRunner; testFiles: string[];
  baseline: ProjectPhase; candidate: ProjectPhase; patched?: ProjectPhase;
  status: 'pass' | 'regression' | 'invalid-baseline' | 'inconclusive';
  patchStatus: 'verified' | 'failed' | 'unverified' | 'not-proposed';
  patchIds: string[]; limitations: string[];
}
export interface FixtureScenario {
  id: string; file: string; exportName: string; args?: JsonValue[]; operation: CallerOperation;
  baselineResponse: { status: number; bodyFile: string };
  candidateResponse: { status: number; bodyFile: string };
  expectedFile: string;
}
export interface Overlay { target: string; source: string }
export interface ProjectManifest {
  id: string; label: string; root: string; include: string[]; baseline: string; candidate: string;
  caller?: { files: string[]; scenarios?: string; fixtureScenarios?: FixtureScenario[]; fieldRenames?: string };
  tests: { trusted: true; runner: ProjectRunner; files: string[]; timeoutMs?: number; baseline?: Overlay[]; candidate?: Overlay[]; dependencyDirectory?: string; config?: string };
}
export interface ProjectSnapshot {
  manifest: ProjectManifest; files: Map<string, Buffer>; root: string;
  dependencyDirectory?: string; protectedFiles: Set<string>; overlays: { baseline: Map<string, Buffer>; candidate: Map<string, Buffer> };
}
