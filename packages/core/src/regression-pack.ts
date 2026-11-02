import { ENGINE_VERSION } from './analyze.js';
import { prepareContract } from './bundle.js';
import { validateConsumerEvidence } from './consumer-impact.js';
import { ContractGuardError } from './errors.js';
import { canonicalJson, fingerprintObject } from './fingerprint.js';
import { validateRulePolicy } from './policy.js';
import type { ConsumerEvidence } from './evidence-types.js';
import type { ContentFingerprint, OpenApiInput, RulePolicy } from './types.js';

export interface RegressionPack {
  kind: 'contractguard-regression';
  schemaVersion: 1;
  engineVersion: string;
  baseline: OpenApiInput;
  candidate: OpenApiInput;
  consumerEvidence: ConsumerEvidence;
  policy?: RulePolicy;
  fingerprint: ContentFingerprint;
}
const MAX_PACK_BYTES = 16 * 1024 * 1024;
// 2.0 unifies product versions without changing 1.5's native replay semantics.
// Explicitly audit each future addition; never accept a broad semver range or rewrite the pack.
const LEGACY_PACK_ENGINES: Readonly<Record<string, readonly string[]>> = { '2.0.0': ['1.5.0'] };
const COMPATIBLE_PACK_ENGINES = new Set([ENGINE_VERSION, ...(LEGACY_PACK_ENGINES[ENGINE_VERSION] ?? [])]);
function fail(message: string): never { throw new ContractGuardError('INVALID_REGRESSION_PACK', message); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Explicit opt-in artifact: unlike saved reports this contains the original examples. */
export function createRegressionPack(
  baseline: OpenApiInput, candidate: OpenApiInput, consumerEvidence: unknown, policy?: RulePolicy,
): RegressionPack {
  const content = {
    kind: 'contractguard-regression' as const, schemaVersion: 1 as const, engineVersion: ENGINE_VERSION,
    baseline: baseline instanceof Uint8Array ? new TextDecoder().decode(baseline) : baseline,
    candidate: candidate instanceof Uint8Array ? new TextDecoder().decode(candidate) : candidate,
    consumerEvidence: validateConsumerEvidence(consumerEvidence),
    ...(policy === undefined ? {} : { policy: validateRulePolicy(policy) }),
  };
  const pack = { ...content, fingerprint: fingerprintObject(content) };
  return validateRegressionPack(pack);
}

export function validateRegressionPack(value: unknown): RegressionPack {
  if (!record(value)) fail('Regression pack must be a JSON object.');
  const keys = new Set(['kind', 'schemaVersion', 'engineVersion', 'baseline', 'candidate', 'consumerEvidence', 'policy', 'fingerprint']);
  if (Object.keys(value).some((key) => !keys.has(key))) fail('Regression pack contains unsupported fields.');
  if (value.kind !== 'contractguard-regression' || value.schemaVersion !== 1) fail('Unsupported regression pack format.');
  if (typeof value.engineVersion !== 'string' || !COMPATIBLE_PACK_ENGINES.has(value.engineVersion)) {
    fail('This pack requires an explicitly compatible engine version. Use its original engine or deliberately recreate it after reviewing the upgrade.');
  }
  let serialized: string;
  try { serialized = canonicalJson(value); } catch { fail('Regression pack is not bounded JSON data.'); }
  if (new TextEncoder().encode(serialized).byteLength > MAX_PACK_BYTES) fail('Regression pack exceeds the 16 MiB limit.');
  const { fingerprint, ...content } = value;
  if (!record(fingerprint) || fingerprint.algorithm !== 'sha256' || typeof fingerprint.value !== 'string'
      || !/^[a-f0-9]{64}$/.test(fingerprint.value) || Object.keys(fingerprint).length !== 2
      || fingerprintObject(content).value !== fingerprint.value) {
    fail('Regression pack fingerprint mismatch. This checksum detects edits; it is not a signature or provenance attestation.');
  }
  for (const side of ['baseline', 'candidate'] as const) {
    const input = value[side];
    if (typeof input !== 'string' && !record(input)) fail('Both pack contracts must be explicit documents or file bundles.');
    prepareContract(input as OpenApiInput);
  }
  const evidence = validateConsumerEvidence(value.consumerEvidence);
  const policy = value.policy === undefined ? undefined : validateRulePolicy(value.policy);
  const normalized = { ...content, consumerEvidence: evidence, ...(policy === undefined ? {} : { policy }) };
  if (canonicalJson(normalized) !== canonicalJson(content)) {
    fail('Regression pack content must already be normalized. Recreate the pack rather than changing its replay inputs.');
  }
  // Freeze the wire representation: caller-owned mutable objects are not retained.
  return JSON.parse(JSON.stringify({ ...normalized, fingerprint })) as RegressionPack;
}
