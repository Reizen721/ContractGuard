import { describe, expect, it } from 'vitest';
import { analyzeRelease, createRegressionPack, ENGINE_VERSION, fingerprintObject, validateRegressionPack } from '../src/index.js';

const baseline = { openapi: '3.1.0', info: { title: 'Pack', version: '1' }, paths: { '/orders': { get: { responses: { '200': {
  description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { receipt: { type: 'string' } } } } },
} } } } } };
const evidence = { schemaVersion: 1, consumers: [{ id: 'checkout', name: 'Checkout', owner: 'Web', criticality: 'critical', interactions: [{
  id: 'receipt', method: 'GET', path: '/orders', response: { status: '200', mediaType: 'application/json',
    baselineBody: { receipt: 'private-example-UNIQUE' }, candidateBody: {},
    expectation: { type: 'object', required: ['receipt'] },
  },
}] }] };

describe('portable consumer regression packs', () => {
  it('replays an unchanged spec consumer regression without rewriting the static verdict', () => {
    const pack = createRegressionPack(baseline, baseline, evidence);
    expect(pack.engineVersion).toBe(ENGINE_VERSION);
    const roundtrip = validateRegressionPack(JSON.parse(JSON.stringify(pack)));
    const result = analyzeRelease(roundtrip.baseline, roundtrip.candidate, { consumerEvidence: roundtrip.consumerEvidence });
    expect(result.changes).toEqual([]);
    expect(result.compatible).toBe(true);
    expect(result.score).toBe(100);
    expect(result.consumerImpact?.gate).toBe('blocked');
    expect(result.consumerImpact?.summary.regressions).toBe(1);
    expect(result.consumerImpact?.consumers[0]?.checks[0]?.relatedChangeIds).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('private-example-UNIQUE');
    expect(JSON.stringify(pack)).toContain('private-example-UNIQUE');
  });
  it('rejects edited inputs, wrong engines, extra fields, and corrupt digests', () => {
    const pack = createRegressionPack(baseline, baseline, evidence);
    for (const bad of [
      { ...pack, engineVersion: '0.0.0' },
      { ...pack, baseline: { ...baseline, info: { title: 'edited' } } },
      { ...pack, hidden: true },
      { ...pack, fingerprint: { algorithm: 'sha256', value: '0'.repeat(64) } },
    ]) expect(() => validateRegressionPack(bad)).toThrow();
  });
  it('replays the explicit 1.5.0 predecessor while preserving its wire version, digest, and gate', () => {
    const { fingerprint: _, ...content } = createRegressionPack(baseline, baseline, evidence, { schemaVersion: 1, id: 'legacy-policy' });
    const legacyContent = { ...content, engineVersion: '1.5.0' };
    const legacy = { ...legacyContent, fingerprint: fingerprintObject(legacyContent) };
    const replay = validateRegressionPack(JSON.parse(JSON.stringify(legacy)));
    expect(replay).toEqual(legacy);
    const result = analyzeRelease(replay.baseline, replay.candidate, { consumerEvidence: replay.consumerEvidence, policy: replay.policy });
    expect(result.engineVersion).toBe(ENGINE_VERSION);
    expect(result.compatible).toBe(true);
    expect(result.consumerImpact?.gate).toBe('blocked');
    expect(result.consumerImpact?.summary.regressions).toBe(1);
    expect(() => validateRegressionPack({ ...legacy, candidate: {} })).toThrow(/fingerprint mismatch/);
  });
  it('does not infer compatibility for unaudited versions, even with valid checksums', () => {
    const { fingerprint: _, ...content } = createRegressionPack(baseline, baseline, evidence);
    for (const engineVersion of ['1.4.0', '1.5.1', '1.8.0', '2.0.1', '2.1.0']) {
      const unknown = { ...content, engineVersion };
      expect(() => validateRegressionPack({ ...unknown, fingerprint: fingerprintObject(unknown) })).toThrow(/explicitly compatible/);
    }
  });
  it('validates content even when an edited payload has a newly computed checksum', () => {
    const pack = createRegressionPack(baseline, baseline, evidence);
    const { fingerprint: _, ...content } = pack;
    const invalid = { ...content, consumerEvidence: { schemaVersion: 1, consumers: [] } };
    expect(() => validateRegressionPack({ ...invalid, fingerprint: fingerprintObject(invalid) })).toThrow();
  });
  it('stores a snapshot and preserves policy without mutating caller inputs', () => {
    const source = structuredClone(evidence);
    const policy = { schemaVersion: 1 as const, id: 'pack-policy' };
    const pack = createRegressionPack(baseline, baseline, source, policy);
    source.consumers[0]!.name = 'Changed later';
    expect(pack.consumerEvidence.consumers[0]?.name).toBe('Checkout');
    expect(pack.policy?.id).toBe('pack-policy');
    expect(validateRegressionPack(pack).fingerprint).toEqual(pack.fingerprint);
  });
  it('rejects a valid checksum over noncanonical manifest values rather than changing replay inputs', () => {
    const { fingerprint: _, ...content } = createRegressionPack(baseline, baseline, evidence);
    content.consumerEvidence.consumers[0]!.interactions[0]!.method = 'get';
    expect(() => validateRegressionPack({ ...content, fingerprint: fingerprintObject(content) })).toThrow(/normalized/);
  });
  it('keeps original API behavior when no consumer evidence was supplied', () => {
    const result = analyzeRelease(baseline, baseline);
    expect(result.consumerImpact).toBeUndefined();
    expect(result.compatible).toBe(true);
  });
});
