import type {
  ContentFingerprint,
  OpenApiInput,
  OperationWitnessSuite,
  SchemaAlignmentReport,
} from '@contractguard/core';
import type { CallerFile, ProgramDataflowReport } from '@contractguard/caller';
import type {
  AdversarialProbeEntrypoint,
  CegarVerificationReport,
  VerificationCounterexample,
} from '@contractguard/project';

export type CegarAgentMode = 'symbolic' | 'llm' | 'hybrid';

export interface CegarRunRequest {
  title?: string;
  mode?: CegarAgentMode;
  providerId?: string;
  maxRounds?: number;
  enableAdversarialFuzzing?: boolean;
  baseline: OpenApiInput;
  candidate: OpenApiInput;
  callerFiles: CallerFile[];
  testFiles: CallerFile[];
  probes?: AdversarialProbeEntrypoint[];
  seedBaselineResponses?: Record<string, { status?: number; body: unknown }>;
}

export interface CegarFilePatch {
  file: string;
  sourceSha256: string;
  patchedSha256: string;
  unifiedDiff: string;
  patchedContent: string;
  rationale: string;
}

export interface CegarRoundRecord {
  round: number;
  proposer: 'symbolic-ast' | 'llm-agent';
  actionSummary: string;
  citedHypothesisIds: string[];
  citedCounterexampleIds: string[];
  patches: CegarFilePatch[];
  verification: {
    verified: boolean;
    compilerClean: boolean;
    nominalPassed: boolean;
    requestContractPassed: boolean;
    adversarialPassed: number;
    adversarialTotal: number;
  };
  counterexamples: VerificationCounterexample[];
  durationMs: number;
}

export interface CegarRunRecord {
  schemaVersion: 1;
  id: string;
  title: string;
  createdAt: string;
  mode: CegarAgentMode;
  providerId?: string;
  maxRounds: number;
  enableAdversarialFuzzing: boolean;
  inputFingerprint: ContentFingerprint;
  /** Original static + unpatched candidate contract gate (preserved for release safety) */
  releaseGate: 'pass' | 'review' | 'blocked';
  /** Caller-specific impact diagnosis using inter-procedural TypeChecker reachability */
  callerImpactStatus:
    | 'unreachable-breaking-safe'
    | 'regression-repaired-verified'
    | 'regression-unresolved'
    | 'compatible-verified';
  patchStatus: 'not-needed' | 'verified' | 'failed';
  alignment: SchemaAlignmentReport;
  dataflow: {
    callsites: ProgramDataflowReport['callsites'];
    fieldUsages: ProgramDataflowReport['fieldUsages'];
    callEdges: ProgramDataflowReport['callEdges'];
    slices: ProgramDataflowReport['slices'];
    metrics: ProgramDataflowReport['metrics'];
    reachability: ProgramDataflowReport['reachability'];
  };
  witnesses: {
    operations: number;
    adversarialCount: number;
    suites: Array<{
      operation: { method: string; path: string };
      baselineNominalId: string;
      candidateNominalId: string;
      adversarial: Array<{ id: string; kind: string; targetPath?: string; description: string }>;
    }>;
  };
  unpatchedVerification: CegarVerificationReport;
  rounds: CegarRoundRecord[];
  finalPatches: CegarFilePatch[];
  llmCalls: number;
  durationMs: number;
  summary: string;
}

export interface CegarPreset {
  id: string;
  label: string;
  category: string;
  description: string;
  expectedRounds: number;
  request: CegarRunRequest;
}
