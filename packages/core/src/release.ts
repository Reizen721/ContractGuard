import { analyzeCompatibility } from './analyze.js';
import { analyzeConsumerImpact, validateConsumerEvidence } from './consumer-impact.js';
import type { AnalysisResult, AnalyzeOptions, OpenApiInput } from './types.js';

/** Combines two independent evidence channels without rewriting the static verdict. */
export function analyzeRelease(
  baseline: OpenApiInput,
  candidate: OpenApiInput,
  options: AnalyzeOptions & { consumerEvidence?: unknown } = {},
): AnalysisResult {
  const evidence = options.consumerEvidence === undefined ? undefined : validateConsumerEvidence(options.consumerEvidence);
  const result = analyzeCompatibility(baseline, candidate, options);
  if (evidence !== undefined) result.consumerImpact = analyzeConsumerImpact(baseline, candidate, evidence, result);
  return result;
}
