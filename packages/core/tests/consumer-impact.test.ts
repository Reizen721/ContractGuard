import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { analyzeCompatibility } from '../src/analyze.js';
import { analyzeConsumerImpact, validateConsumerEvidence } from '../src/consumer-impact.js';
import type { ConsumerEvidence, ConsumerInteraction } from '../src/evidence-types.js';
import type { OpenApiDocument, OpenApiInput, OpenApiBundleInput } from '../src/types.js';

function spec(schema: unknown = { type: 'object', required: ['quantity'], properties: { quantity: { type: 'integer', minimum: 1 } } }): OpenApiDocument {
  return { openapi: '3.1.0', info: { title: 'Order service', version: '1' }, paths: { '/orders': { post: {
    requestBody: { required: true, content: { 'application/json': { schema } } },
    responses: { '200': { description: 'Order', content: { 'application/json': { schema: {
      type: 'object', required: ['id'], properties: { id: { type: 'integer' }, receipt: { type: 'string' } },
    } } } } },
  } } } };
}
function operation(document: OpenApiDocument): any { return (document.paths as any)['/orders'].post; }
function evidence(interaction: Partial<ConsumerInteraction> = {}): ConsumerEvidence {
  return { schemaVersion: 1, consumers: [{ id: 'checkout', name: 'Checkout', owner: 'Payments', criticality: 'critical', interactions: [{
    id: 'create', method: 'POST', path: '/orders', request: { mediaType: 'application/json', body: { quantity: 1 } }, ...interaction,
  }] }] };
}
function responseEvidence(candidateBody: unknown = { id: 2, receipt: '/receipts/2' }): ConsumerEvidence {
  const input = evidence();
  delete input.consumers[0]!.interactions[0]!.request;
  input.consumers[0]!.interactions[0]!.response = { status: '200', mediaType: 'application/json', baselineBody: { id: 1, receipt: '/receipts/1' }, candidateBody,
    expectation: { type: 'object', required: ['receipt'], properties: { receipt: { type: 'string' } } } };
  return input;
}
function run(old: OpenApiInput, candidate: OpenApiInput = old, input: unknown = evidence()) {
  return analyzeConsumerImpact(old, candidate, input, analyzeCompatibility(old, candidate));
}
function first(report: ReturnType<typeof run>) { return report.consumers[0]!.checks[0]!; }
function codes(value: { issues: Array<{ code: string }> }) { return value.issues.map((issue) => issue.code); }

describe('consumer evidence manifest validation', () => {
  it('accepts explicit examples, normalizes method/media names and returns a detached JSON copy', () => {
    const input = evidence({ method: 'post', request: { mediaType: 'Application/JSON', body: null } });
    const normalized = validateConsumerEvidence(input);
    expect(normalized.consumers[0]!.interactions[0]!.method).toBe('POST');
    expect(normalized.consumers[0]!.interactions[0]!.request!.mediaType).toBe('application/json');
    normalized.consumers[0]!.name = 'Changed';
    expect(input.consumers[0]!.name).toBe('Checkout');
  });

  it.each([
    { schemaVersion: 2, consumers: [] },
    { ...evidence(), consumerz: [] },
    { schemaVersion: 1, consumers: [] },
    { schemaVersion: 1, consumers: [evidence().consumers[0], evidence().consumers[0]] },
    evidence({ id: 'bad:id' }),
    evidence({ method: 'FETCH' }),
    evidence({ path: 'https://service.invalid/orders' }),
    evidence({ path: '/orders?debug=1' }),
    evidence({ request: { body: {} } }),
    evidence({ request: { mediaType: 'application/json; charset=utf-8', body: {} } }),
    evidence({ request: { parameters: { header: { 'X-Region': 'eu', 'x-region': 'us' } } } }),
  ])('rejects malformed or ambiguous manifest shape %#', (input) => {
    expect(() => validateConsumerEvidence(input)).toThrowError(expect.objectContaining({ code: 'INVALID_CONSUMER_EVIDENCE' }));
  });

  it('rejects unknown fields rather than silently dropping a misspelled assertion', () => {
    const input: any = responseEvidence();
    input.consumers[0].interactions[0].response.expecation = {};
    expect(() => validateConsumerEvidence(input)).toThrow('unsupported field');
  });

  it('requires real checks and unique interaction ids', () => {
    const input = evidence();
    delete input.consumers[0]!.interactions[0]!.request;
    expect(() => validateConsumerEvidence(input)).toThrow('request or response');
    const duplicate = evidence();
    duplicate.consumers[0]!.interactions.push(duplicate.consumers[0]!.interactions[0]!);
    expect(() => validateConsumerEvidence(duplicate)).toThrow('duplicate interaction');
  });

  it('requires baseline response data but allows absent candidate evidence', () => {
    const input = responseEvidence();
    delete input.consumers[0]!.interactions[0]!.response!.candidateBody;
    expect(() => validateConsumerEvidence(input)).not.toThrow();
    delete (input.consumers[0]!.interactions[0]!.response as any).baselineBody;
    expect(() => validateConsumerEvidence(input)).toThrow('baselineBody');
  });

  it('bounds size/count/depth and rejects cycles or non-JSON numbers', () => {
    const tooMany = evidence();
    tooMany.consumers[0]!.interactions = Array.from({ length: 201 }, (_, index) => ({ id: `i-${index}`, method: 'GET', path: '/orders', request: {} }));
    expect(() => validateConsumerEvidence(tooMany)).toThrow('at most 200');
    const large = evidence({ request: { mediaType: 'application/json', body: 'x'.repeat(1024 * 1024) } });
    expect(() => validateConsumerEvidence(large)).toThrow('byte limit');
    const cycle: any = {}; cycle.child = cycle;
    expect(() => validateConsumerEvidence(evidence({ request: { mediaType: 'application/json', body: cycle } }))).toThrow('circular');
    expect(() => validateConsumerEvidence(evidence({ request: { mediaType: 'application/json', body: NaN } }))).toThrow('finite JSON');
    let nested: any = {};
    for (let index = 0; index < 70; index += 1) nested = { nested };
    expect(() => validateConsumerEvidence(evidence({ request: { mediaType: 'application/json', body: nested } }))).toThrow('depth budget');
  });

  it('rejects accessors before invoking them and disallows lossy non-JSON array properties', () => {
    let invoked = false;
    const payload = Object.defineProperty({}, 'secret', { enumerable: true, get() { invoked = true; return 'do-not-read'; } });
    expect(() => validateConsumerEvidence(evidence({ request: { mediaType: 'application/json', body: payload } }))).toThrow('accessor');
    expect(invoked).toBe(false);
    const array: any = [1]; array.extra = 2;
    expect(() => validateConsumerEvidence(evidence({ request: { mediaType: 'application/json', body: array } }))).toThrow('named properties');
  });
});

describe('consumer impact evidence checks', () => {
  it('proves an old accepted request violates a tightened candidate bound and links owner/tasks', () => {
    const old = spec(); const candidate = spec({ type: 'object', required: ['quantity'], properties: { quantity: { type: 'integer', minimum: 2 } } });
    const report = run(old, candidate);
    expect(first(report).status).toBe('regression');
    expect(first(report).baseline.status).toBe('valid');
    expect(first(report).candidate.status).toBe('invalid');
    expect(first(report).relatedChangeIds.length).toBeGreaterThan(0);
    expect(report.gate).toBe('blocked');
    expect(report.migrationTasks[0]).toMatchObject({ owner: 'Payments', priority: 'high', checkIds: ['checkout:create:request'] });
    expect(report.summary).toMatchObject({ consumers: 1, interactions: 1, checks: 1, regressions: 1 });
  });

  it('detects a consumer response failure with identical provider contracts and zero static findings', () => {
    const old = spec(); const analysis = analyzeCompatibility(old, old);
    expect(analysis.changes).toEqual([]);
    const report = analyzeConsumerImpact(old, old, responseEvidence({ id: 2 }), analysis);
    expect(first(report).status).toBe('regression');
    expect(first(report).relatedChangeIds).toEqual([]);
    expect(first(report).candidate.issues.some((issue) => issue.path.startsWith('/response/expectation'))).toBe(true);
    expect(report.gate).toBe('blocked');
  });

  it('checks candidate bodies against the provider schema even if the consumer assertion passes', () => {
    const input = responseEvidence({ id: 'wrong-type', receipt: '/receipts/2' });
    const report = run(spec(), spec(), input);
    expect(first(report).status).toBe('regression');
    expect(first(report).candidate.issues.some((issue) => issue.path.startsWith('/response/body'))).toBe(true);
  });

  it('passes finite unaffected examples without generating migration work', () => {
    const report = run(spec());
    expect(first(report).status).toBe('pass');
    expect(report.gate).toBe('pass');
    expect(report.migrationTasks).toEqual([]);
    expect(run(spec(), spec(), responseEvidence()).gate).toBe('pass');
  });

  it('does not attribute already-invalid baseline samples to an API migration', () => {
    const input = evidence({ request: { mediaType: 'application/json', body: { quantity: 0 } } });
    const report = run(spec(), spec(), input);
    expect(first(report).status).toBe('invalid-baseline');
    expect(report.summary.regressions).toBe(0);
    expect(report.gate).toBe('review');
    const badResponse = responseEvidence(); badResponse.consumers[0]!.interactions[0]!.response!.baselineBody = { id: 1 };
    expect(first(run(spec(), spec(), badResponse)).status).toBe('invalid-baseline');
  });

  it('keeps absent candidate examples inconclusive and distinguishes JSON null from omission', () => {
    const input = responseEvidence(); delete input.consumers[0]!.interactions[0]!.response!.candidateBody;
    const report = run(spec(), spec(), input);
    expect(first(report).status).toBe('inconclusive');
    expect(codes(first(report).candidate)).toContain('CANDIDATE_EXAMPLE_MISSING');
    expect(report.gate).toBe('review');
    expect(first(run(spec(), spec(), responseEvidence(null))).status).toBe('regression');
  });

  it('marks unsupported baseline constraints inconclusive even when the candidate has a known failure', () => {
    const old = spec({ type: 'object', properties: { quantity: { type: 'integer', format: 'int64' } } });
    const candidate = spec({ type: 'object', properties: { quantity: { type: 'integer', minimum: 2 } } });
    const report = run(old, candidate);
    expect(first(report).baseline.status).toBe('unknown');
    expect(first(report).candidate.status).toBe('invalid');
    expect(first(report).status).toBe('inconclusive');
    expect(report.gate).toBe('review');
  });

  it('recognizes operation, response status and media removal', () => {
    const old = spec(); const noOperation = spec(); (noOperation.paths as any)['/orders'] = {};
    expect(first(run(old, noOperation)).status).toBe('regression');
    const noStatus = spec(); operation(noStatus).responses = { '404': { description: 'Not found' } };
    expect(codes(first(run(old, noStatus, responseEvidence())).candidate)).toContain('STATUS_NOT_DECLARED');
    const noMedia = spec(); operation(noMedia).responses['200'].content = { 'text/plain': { schema: { type: 'string' } } };
    expect(codes(first(run(old, noMedia, responseEvidence())).candidate)).toContain('MEDIA_TYPE_NOT_DECLARED');
  });

  it('withholds conclusions on case-colliding media keys instead of reporting a fabricated removal', () => {
    const old = spec(); const candidate = spec();
    operation(candidate).requestBody.content['Application/JSON'] = { schema: { type: 'string' } };
    const report = run(old, candidate);
    expect(first(report).status).toBe('inconclusive');
    expect(codes(first(report).candidate)).toContain('AMBIGUOUS_MEDIA_TYPE');
    expect(codes(first(report).candidate)).not.toContain('MEDIA_TYPE_NOT_DECLARED');
    expect(report.summary.regressions).toBe(0);
  });

  it('supports exact status, status-range and default response selection with precise precedence', () => {
    const old = spec(); const response = operation(old).responses['200'];
    operation(old).responses = { '2XX': response };
    expect(first(run(old, old, responseEvidence())).status).toBe('pass');
    operation(old).responses = { default: response };
    expect(first(run(old, old, responseEvidence())).status).toBe('pass');
    operation(old).responses['200'] = { description: 'Exact', content: { 'application/json': { schema: false } } };
    expect(first(run(old, old, responseEvidence())).status).toBe('invalid-baseline');
  });

  it('checks required request parameters/body while respecting operation parameter overrides', () => {
    const old = spec(); operation(old).requestBody.required = false;
    const candidate = structuredClone(old);
    (old.paths as any)['/orders'].parameters = [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 10 } }];
    (candidate.paths as any)['/orders'].parameters = (old.paths as any)['/orders'].parameters;
    operation(candidate).parameters = [{ name: 'limit', in: 'query', required: true, schema: { type: 'integer', maximum: 5 } }];
    const input = evidence({ request: { parameters: { query: { limit: 8 } } } });
    expect(first(run(old, candidate, input)).status).toBe('regression');
    expect(codes(first(run(old, candidate, evidence({ request: {} }))).candidate)).toContain('REQUIRED_PARAMETER_MISSING');
    const bodyRequired = structuredClone(old); operation(bodyRequired).requestBody.required = true;
    expect(codes(first(run(old, bodyRequired, evidence({ request: {} }))).candidate)).toContain('REQUIRED_BODY_MISSING');
  });

  it('matches header names case-insensitively and preserves path/query case sensitivity', () => {
    const document = spec(); operation(document).parameters = [{ name: 'X-REGION', in: 'header', required: true, schema: { type: 'string', enum: ['eu'] } }];
    const input = evidence({ request: { mediaType: 'application/json', body: { quantity: 1 }, parameters: { header: { 'x-region': 'eu' } } } });
    expect(first(run(document, document, input)).status).toBe('pass');
    operation(document).parameters[0] = { name: 'Region', in: 'query', required: true, schema: { type: 'string' } };
    input.consumers[0]!.interactions[0]!.request!.parameters = { query: { region: 'eu' } };
    expect(first(run(document, document, input)).status).toBe('invalid-baseline');
  });

  it('withholds failure claims for malformed path parameter requirements and optional schema shapes', () => {
    const old = spec(); const candidate = spec();
    (old.paths as any)['/orders/{id}'] = (old.paths as any)['/orders']; delete (old.paths as any)['/orders'];
    (candidate.paths as any)['/orders/{id}'] = (candidate.paths as any)['/orders']; delete (candidate.paths as any)['/orders'];
    (old.paths as any)['/orders/{id}'].post.parameters = [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }];
    (candidate.paths as any)['/orders/{id}'].post.parameters = [{ name: 'id', in: 'path', required: false, schema: { type: 'integer' } }];
    const input = evidence({ path: '/orders/{id}', request: { mediaType: 'application/json', body: { quantity: 1 }, parameters: { path: { id: 1 } } } });
    const report = run(old, candidate, input);
    expect(first(report).status).toBe('inconclusive');
    expect(codes(first(report).candidate)).toContain('INVALID_PATH_PARAMETER_REQUIRED');
    const bad = spec(); operation(bad).parameters = [{ name: 'q', in: 'query', schema: null }];
    expect(codes(first(run(bad)).baseline)).toContain('INVALID_PARAMETER_SCHEMA');
  });

  it('does not silently accept undeclared parameters or duplicate parameter definitions', () => {
    const input = evidence({ request: { mediaType: 'application/json', body: { quantity: 1 }, parameters: { query: { secret: 'token-not-in-report' } } } });
    const report = run(spec(), spec(), input);
    expect(first(report).status).toBe('inconclusive');
    expect(codes(first(report).baseline)).toContain('UNDECLARED_PARAMETER');
    expect(JSON.stringify(report)).not.toContain('token-not-in-report');
    const document = spec(); operation(document).parameters = [{ name: 'a', in: 'query', schema: {} }, { name: 'a', in: 'query', schema: {} }];
    expect(codes(first(run(document)).baseline)).toContain('DUPLICATE_PARAMETER');
  });

  it('treats authentication and custom wire encodings as unverified, allowing explicitly anonymous alternatives', () => {
    const secured = spec(); secured.security = [{ bearer: [] }]; secured.components = { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } };
    expect(codes(first(run(secured)).baseline)).toContain('AUTHENTICATION_NOT_VALIDATED');
    secured.security = [{ bearer: [] }, {}];
    expect(first(run(secured)).status).toBe('pass');
    const encoding = spec(); operation(encoding).requestBody.content['application/json'].encoding = { quantity: { style: 'form' } };
    expect(codes(first(run(encoding)).baseline)).toContain('ENCODING_NOT_VALIDATED');
    const parameter = spec(); operation(parameter).parameters = [{ name: 'limit', in: 'query', schema: { type: 'integer' }, style: 'form' }];
    const input = evidence({ request: { mediaType: 'application/json', body: { quantity: 1 }, parameters: { query: { limit: 10 } } } });
    expect(codes(first(run(parameter, parameter, input)).baseline)).toContain('PARAMETER_SERIALIZATION_NOT_VALIDATED');
  });

  it('preserves original contract references and rejects ambiguous Path Item merges', () => {
    const document = spec(); document.components = { pathItems: { Orders: (document.paths as any)['/orders'] } };
    document.paths = { '/orders': { $ref: '#/components/pathItems/Orders' } };
    expect(first(run(document)).status).toBe('pass');
    const conflict = structuredClone(document); (conflict.paths as any)['/orders'].post = { responses: {} };
    expect(codes(first(run(document, conflict)).candidate)).toContain('PATH_REFERENCE_AMBIGUOUS');
    expect(first(run(document, conflict)).status).toBe('inconclusive');
  });

  it('validates external bundle schema references using the prepared graph', () => {
    function bundle(minimum: number): OpenApiBundleInput {
      return { kind: 'bundle', entry: 'openapi.json', files: [
        { path: 'openapi.json', content: JSON.stringify(spec({ $ref: 'schemas/order.json' })) },
        { path: 'schemas/order.json', content: JSON.stringify({ type: 'object', properties: { quantity: { type: 'integer', minimum } } }) },
      ] };
    }
    expect(first(run(bundle(1), bundle(2))).status).toBe('regression');
  });

  it('supports 3.0 nullable to 3.1 union equivalence for supplied null requests', () => {
    const old = spec({ type: 'string', nullable: true }); old.openapi = '3.0.4';
    const candidate = spec({ type: ['string', 'null'] });
    const input = evidence({ request: { mediaType: 'application/json', body: null } });
    expect(first(run(old, candidate, input)).status).toBe('pass');
  });

  it('leaves unrelated risk findings unmapped and requests review instead of assuming an unused API', () => {
    const old = spec(); (old.paths as any)['/orders/archive'] = { delete: { responses: { '204': { description: 'Deleted' } } } };
    const candidate = structuredClone(old); delete (candidate.paths as any)['/orders/archive'];
    const report = run(old, candidate);
    expect(first(report).status).toBe('pass');
    expect(first(report).relatedChangeIds).toEqual([]);
    expect(report.unmappedChangeIds.length).toBeGreaterThan(0);
    expect(report.gate).toBe('review');
  });

  it('keeps incomplete static coverage visible even if all consumer examples pass', () => {
    const document = spec(); document.webhooks = { changed: { post: { responses: { '200': { description: 'OK' } } } } };
    const report = run(document);
    expect(first(report).status).toBe('pass');
    expect(report.gate).toBe('review');
  });

  it('retains only a canonical evidence fingerprint and issue paths, not submitted body values', () => {
    const input = evidence({ request: { mediaType: 'application/json', body: { quantity: 'sensitive-value-do-not-save' } } });
    const report = run(spec(), spec(), input);
    expect(JSON.stringify(report)).not.toContain('sensitive-value-do-not-save');
    expect(report.fingerprint.value).toMatch(/^[a-f0-9]{64}$/);
    const reordered = JSON.parse(JSON.stringify(input));
    reordered.consumers[0].interactions[0].request = { body: { quantity: 'sensitive-value-do-not-save' }, mediaType: 'application/json' };
    expect(run(spec(), spec(), reordered).fingerprint).toEqual(report.fingerprint);
    reordered.consumers[0].interactions[0].request.body.quantity = 'another-sensitive-value';
    expect(run(spec(), spec(), reordered).fingerprint).not.toEqual(report.fingerprint);
  });

  it('rejects a mismatched static analysis rather than attaching evidence to another input snapshot', () => {
    const old = spec(); const other = spec({ type: 'string' });
    expect(() => analyzeConsumerImpact(old, other, evidence(), analyzeCompatibility(old, old))).toThrow('same baseline and candidate');
  });

  it('bounds total schema evaluations across the whole manifest and exposes unchecked examples', () => {
    const input = responseEvidence();
    input.consumers[0]!.interactions[0]!.request = { mediaType: 'application/json', body: { quantity: 1 } };
    const template = input.consumers[0]!.interactions[0]!;
    input.consumers[0]!.interactions = Array.from({ length: 200 }, (_, index) => ({ ...structuredClone(template), id: `example-${index}` }));
    const report = run(spec(), spec(), input);
    expect(report.summary.regressions).toBe(0);
    expect(report.summary.inconclusive).toBeGreaterThan(0);
    expect(report.consumers[0]!.checks.at(-1)!.candidate.truncated).toBe(true);
    expect(codes(report.consumers[0]!.checks.at(-1)!.candidate)).toContain('EVIDENCE_WORK_LIMIT');
    expect(report.gate).toBe('review');
  });

  it('bounds repeated large parameter scans independently of schema evaluation count', () => {
    const document = spec(); delete operation(document).requestBody;
    operation(document).parameters = Array.from({ length: 60 }, (_, index) => ({ name: `p${index}`, in: 'query', schema: { type: 'string' } }));
    const input = evidence();
    input.consumers[0]!.interactions = Array.from({ length: 100 }, (_, index) => ({ id: `example-${index}`, method: 'POST', path: '/orders', request: {} }));
    const report = run(document, document, input);
    expect(report.summary.inconclusive).toBeGreaterThan(0);
    expect(report.summary.regressions).toBe(0);
    expect(codes(report.consumers[0]!.checks.at(-1)!.candidate)).toContain('EVIDENCE_WORK_LIMIT');
  });

  it('runs the shared retail scenario with fixed independent expected outcomes and unaffected control', () => {
    // Tests compile to .test-dist/tests; URLs deliberately resolve from that runtime location.
    const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../../fixtures/consumer-impact/${name}.json`, import.meta.url), 'utf8'));
    const old = fixture('baseline'); const candidate = fixture('candidate'); const input = fixture('consumers');
    const report = run(old, candidate, input);
    expect(report.summary).toEqual({ consumers: 3, interactions: 3, checks: 4, passed: 1, regressions: 3, invalidBaselines: 0, inconclusive: 0 });
    expect(report.consumers.find((consumer) => consumer.id === 'analytics-dashboard')!.checks.every((check) => check.status === 'pass')).toBe(true);
    expect(report.consumers.find((consumer) => consumer.id === 'mobile-checkout')!.checks.map((check) => check.status)).toEqual(['regression', 'regression']);
    expect(report.migrationTasks.map((task) => task.priority)).toEqual(['high', 'high', 'normal']);
    expect(report.unmappedChangeIds).toEqual([]);
    // Evidence-only control: no spec change, still a concrete response-expectation failure.
    const same = run(old, old, input);
    expect(same.summary).toMatchObject({ passed: 3, regressions: 1 });
    expect(same.consumers[0]!.checks[1]!.relatedChangeIds).toEqual([]);
  });
});
