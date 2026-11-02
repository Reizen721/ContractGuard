export { analyzeCompatibility, ENGINE_VERSION } from "./analyze.js";
export { analyzeRelease } from "./release.js";
export { analyzeConsumerImpact, validateConsumerEvidence } from "./consumer-impact.js";
export { validateEvidenceValue } from "./evidence-schema.js";
export { createRegressionPack, validateRegressionPack } from "./regression-pack.js";
export type { RegressionPack } from "./regression-pack.js";
export { consumerReportLines } from "./evidence-report.js";
export type * from "./evidence-types.js";
export { ContractGuardError, type ContractGuardErrorCode } from "./errors.js";
export { canonicalJson, fingerprintObject, fingerprintOpenApiInput, fingerprintText } from "./fingerprint.js";
export { prepareContract, locateContractSource, type PreparedContract } from "./bundle.js";
export { parseOpenApi, resolveLocalRef, resolveNode } from "./parser.js";
export { DEFAULT_RULE_POLICY, DEFAULT_SCORING_WEIGHTS, resolveRulePolicy, validateRulePolicy } from "./policy.js";
export { getRule, ruleCatalog } from "./rules.js";
export type {
  AnalysisResult,
  AnalysisCoverage,
  AppliedPolicy,
  AnalyzeOptions,
  Change,
  ChangeCategory,
  ChangeSummary,
  ContentFingerprint,
  ContractBundleMetadata,
  ContractFile,
  ContractSourceLocation,
  CoverageWarning,
  OpenApiBundleInput,
  OpenApiDocument,
  OpenApiInput,
  ParsedOpenApi,
  RuleDefinition,
  RulePolicy,
  RulePolicyRule,
  Severity,
  SourceDescription,
} from "./types.js";
