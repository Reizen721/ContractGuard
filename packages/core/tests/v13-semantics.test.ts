import { describe, expect, it } from 'vitest';
import { analyzeCompatibility } from '../src/analyze.js';
import { parseOpenApi, pathItemReferenceConflicts, resolveNode, resolvePathItemNode, resolveSchemaNode } from '../src/parser.js';

type Schema = Record<string, any> | boolean;
function document(schema: Schema, version = '3.1.0'): Record<string, any> {
  return {
    openapi: version, info: { title: 'V1.3 semantic regression', version: '1' },
    paths: { '/probe': { post: {
      requestBody: { content: { 'application/json': { schema } } },
      responses: { 200: { description: 'OK' } },
    } } },
  };
}
function compare(before: Schema, after: Schema, version = '3.1.0') {
  return analyzeCompatibility(document(before, version), document(after, version));
}

describe('V1.3 dialect-aware normalization', () => {
  it('preserves non-conflicting Path Item reference sibling operations', () => {
    const before = document({ type: 'string' });
    before.components = { pathItems: { Base: { get: { responses: { 200: { description: 'OK' } } } } } };
    before.paths['/probe'] = { $ref: '#/components/pathItems/Base', post: { responses: { 201: { description: 'Created' } } } };
    const after = structuredClone(before);
    delete after.paths['/probe'].post;
    const result = analyzeCompatibility(before, after);
    expect(result.changes).toContainEqual(expect.objectContaining({ ruleId: 'OPERATION_REMOVED', severity: 'breaking', location: 'paths["/probe"].post' }));
    expect(result.coverage?.warnings.some((warning) => warning.code === 'REFERENCE_SIBLINGS_IGNORED')).toBe(false);
  });

  it('exposes ambiguous Path Item overlapping fields and withholds operation judgments', () => {
    const before = document({ type: 'string' });
    before.components = { pathItems: { Base: { get: { responses: { 200: { description: 'OK' } } } } } };
    before.paths['/probe'] = { $ref: '#/components/pathItems/Base', get: { responses: { 201: { description: 'Different' } } } };
    const after = structuredClone(before);
    delete after.paths['/probe'].get;
    const result = analyzeCompatibility(before, after);
    expect(result.coverage?.warnings).toContainEqual(expect.objectContaining({ code: 'PATH_ITEM_REFERENCE_CONFLICT', side: 'old' }));
    expect(result.changes).toEqual([]);
  });

  it('propagates conflict warnings through chained Path Item references', () => {
    const spec = parseOpenApi({ openapi: '3.1.0', paths: {}, components: { pathItems: {
      Base: { get: { responses: { 200: { description: 'OK' } } } },
      Mid: { $ref: '#/components/pathItems/Base', get: { responses: { 202: { description: 'Conflict' } } } },
    } } }).document;
    const chained = { $ref: '#/components/pathItems/Mid', post: { responses: { 201: { description: 'OK' } } } };
    expect(resolvePathItemNode(spec, chained)).toHaveProperty('post');
    expect(pathItemReferenceConflicts(spec, chained)).toContain('get');
  });

  it('recognizes equivalent OpenAPI 3.0 nullable and 3.1 null union types', () => {
    const result = analyzeCompatibility(document({ type: 'string', nullable: true }, '3.0.4'), document({ type: ['string', 'null'] }));
    expect(result.changes).toEqual([]);
    expect(result.source.old.dialect).toBe('openapi-3.0');
    expect(result.source.new.dialect).toBe('https://spec.openapis.org/oas/3.1/dialect/base');
    expect(result.coverage?.status).toBe('complete');
  });

  it('requires an explicit OpenAPI 3.0 type for nullable', () => {
    const result = compare({}, { nullable: true }, '3.0.4');
    expect(result.changes).toEqual([]);
    expect(result.coverage?.warnings.some((warning) => warning.code === 'NULLABLE_WITHOUT_EXPLICIT_TYPE')).toBe(true);
  });

  it('does not infer an object type from properties alone', () => {
    const result = compare({ properties: {} }, { type: 'object', properties: {} });
    expect(result.changes).toContainEqual(expect.objectContaining({ ruleId: 'SCHEMA_TYPE_CHANGED', severity: 'breaking' }));
  });

  it('does not grant nullability to a 3.1 nullable annotation', () => {
    const result = compare({ type: 'string' }, { type: 'string', nullable: true });
    expect(result.changes).toEqual([]);
    expect(result.coverage?.warnings).toContainEqual(expect.objectContaining({ code: 'OAS31_NULLABLE_IGNORED', side: 'new' }));
  });

  it('ignores OpenAPI 3.0 Reference Object siblings instead of overwriting the target', () => {
    const spec = parseOpenApi({ openapi: '3.0.4', paths: {}, components: { schemas: { Base: { type: 'string' } } } }).document;
    expect(resolveNode(spec, { $ref: '#/components/schemas/Base', type: 'number', description: 'ignored' })).toEqual({ type: 'string' });
    expect(resolveSchemaNode(spec, { $ref: '#/components/schemas/Base', type: 'number' })).toEqual({ type: 'string' });
  });

  it('retains only permitted metadata on OpenAPI 3.1 non-schema references', () => {
    const spec = parseOpenApi({ openapi: '3.1.0', paths: {}, components: { responses: { Base: { description: 'base' } } } }).document;
    expect(resolveNode(spec, { $ref: '#/components/responses/Base', description: 'override', summary: 'summary', content: { fake: {} } })).toEqual({ description: 'override', summary: 'summary' });
  });

  it('conjoins 3.1 primitive reference constraints rather than overwriting a stronger bound', () => {
    const before = document({ $ref: '#/components/schemas/Base' });
    before.components = { schemas: { Base: { type: 'number', maximum: 10 } } };
    const after = structuredClone(before);
    after.paths['/probe'].post.requestBody.content['application/json'].schema.maximum = 20;
    const result = analyzeCompatibility(before, after);
    expect(result.changes).toEqual([]);
    expect(result.coverage?.status).toBe('complete');
    after.paths['/probe'].post.requestBody.content['application/json'].schema.maximum = 5;
    expect(analyzeCompatibility(before, after).changes).toContainEqual(expect.objectContaining({ ruleId: 'SCHEMA_CONSTRAINT_TIGHTENED', severity: 'breaking' }));
  });

  it('turns an impossible 3.1 reference conjunction into false rather than replacing its type', () => {
    const before = document({ $ref: '#/components/schemas/Base' });
    before.components = { schemas: { Base: { type: 'string' } } };
    const after = structuredClone(before);
    after.paths['/probe'].post.requestBody.content['application/json'].schema.type = 'number';
    expect(analyzeCompatibility(before, after).changes).toContainEqual(expect.objectContaining({ ruleId: 'SCHEMA_BOOLEAN_CHANGED', severity: 'breaking' }));
  });

  it('keeps complex reference sibling conjunctions opaque, without fabricated safe type findings', () => {
    const before = document({ $ref: '#/components/schemas/Base' });
    before.components = { schemas: { Base: { type: 'object', additionalProperties: false, properties: { old: { type: 'string' } } } } };
    const after = structuredClone(before);
    after.paths['/probe'].post.requestBody.content['application/json'].schema.properties = { added: { type: 'number' } };
    const result = analyzeCompatibility(before, after);
    expect(result.coverage?.warnings.some((warning) => warning.code === 'SCHEMA_REF_CONJUNCTION_PARTIAL')).toBe(true);
    expect(result.changes.every((change) => change.severity === 'potentially-breaking')).toBe(true);
  });
});

describe('V1.3 explicit coverage boundaries', () => {
  it.each([true, false])('allows OpenAPI 3.0 additionalProperties: %s without a false boolean-schema warning', (additionalProperties) => {
    const spec = document({ type: 'object', additionalProperties }, '3.0.4');
    expect(analyzeCompatibility(spec, spec).coverage).toEqual({ status: 'complete', warnings: [], truncated: false });
  });

  it('still rejects a standalone OpenAPI 3.0 boolean schema from precise comparison', () => {
    const result = compare({ type: 'array', items: { type: 'string' } }, { type: 'array', items: false }, '3.0.4');
    expect(result.coverage?.warnings.some((warning) => warning.code === 'OAS30_BOOLEAN_SCHEMA')).toBe(true);
    expect(result.changes.every((change) => change.severity === 'potentially-breaking')).toBe(true);
  });

  it('keeps open-object additionalProperties semantics when judging a new typed 3.0 property', () => {
    expect(compare({ type: 'object', additionalProperties: true }, { type: 'object', additionalProperties: true, properties: { note: { type: 'string' } } }, '3.0.4').changes)
      .toContainEqual(expect.objectContaining({ ruleId: 'SCHEMA_PROPERTY_ADDED', severity: 'breaking' }));
  });

  it('withholds definite schema judgments under an unknown document dialect', () => {
    const before = document({ type: 'string' });
    const after = document({ type: 'number' });
    before.jsonSchemaDialect = after.jsonSchemaDialect = 'https://example.invalid/custom';
    const result = analyzeCompatibility(before, after);
    expect(result.coverage?.status).toBe('partial');
    expect(result.coverage?.warnings.some((warning) => warning.code === 'UNSUPPORTED_SCHEMA_DIALECT')).toBe(true);
    expect(result.summary.breaking).toBe(0);
    expect(result.summary.potentiallyBreaking).toBe(1);
  });

  it('withholds judgments only in a nested unknown-dialect subtree', () => {
    const before = document({ type: 'object', properties: { unknown: { $schema: 'https://example.invalid/custom', type: 'string' }, known: { type: 'string' } } });
    const after = structuredClone(before);
    after.paths['/probe'].post.requestBody.content['application/json'].schema.properties.unknown.type = 'number';
    after.paths['/probe'].post.requestBody.content['application/json'].schema.properties.known.type = 'number';
    const result = analyzeCompatibility(before, after);
    expect(result.summary.breaking).toBe(1);
    expect(result.summary.potentiallyBreaking).toBe(1);
    expect(result.coverage?.warnings.some((warning) => warning.location.includes('unknown'))).toBe(true);
  });

  it.each(['$id', '$anchor', '$dynamicRef'])('exposes unsupported %s scope instead of precise type conclusions', (keyword) => {
    const result = compare({ [keyword]: '#custom', type: 'string' }, { [keyword]: '#custom', type: 'number' });
    expect(result.coverage?.status).toBe('partial');
    expect(result.changes.every((change) => change.severity === 'potentially-breaking')).toBe(true);
  });

  it('does not scan example payloads as contract schemas or references', () => {
    const spec = document({ type: 'object', example: { $ref: 'https://do-not-fetch.invalid', $schema: 'unsupported', webhooks: {} } });
    spec.paths['/probe'].post.requestBody.content['application/json'].examples = { demo: { value: { $ref: 'invalid', const: 1 } } };
    expect(analyzeCompatibility(spec, spec).coverage).toEqual({ status: 'complete', warnings: [], truncated: false });
  });

  it('retains coverage omissions even when their rules are disabled', () => {
    const before = document({ type: 'string', const: 'a' });
    const after = document({ type: 'string', const: 'b' });
    const result = analyzeCompatibility(before, after, { policy: { schemaVersion: 1, rules: { SCHEMA_UNSUPPORTED_KEYWORD_CHANGED: { enabled: false } } } });
    expect(result.changes).toEqual([]);
    expect(result.compatible).toBe(true);
    expect(result.coverage?.status).toBe('partial');
  });

  it('reports callbacks, webhooks and media encoding as independent coverage warnings', () => {
    const spec = document({ type: 'object' });
    spec.webhooks = { payment: { post: { responses: { 200: { description: 'OK' } } } } };
    spec.paths['/probe'].post.callbacks = { done: {} };
    spec.paths['/probe'].post.requestBody.content['multipart/form-data'] = { schema: { type: 'object' }, encoding: { attachment: { contentType: 'image/png' } } };
    const codes = analyzeCompatibility(spec, spec).coverage!.warnings.map((warning) => warning.code);
    expect(codes).toContain('WEBHOOKS_NOT_ANALYSED');
    expect(codes).toContain('CALLBACKS_NOT_ANALYSED');
    expect(codes).toContain('MEDIA_ENCODING_NOT_ANALYSED');
  });

  it('caps warnings, marks truncation, and remains deterministic', () => {
    const spec = document({ type: 'object', properties: Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`field${index}`, { const: index }])) });
    const first = analyzeCompatibility(spec, spec).coverage!;
    expect(first.warnings.length).toBe(100);
    expect(first.truncated).toBe(true);
    expect(first).toEqual(analyzeCompatibility(spec, spec).coverage);
  });

  it('bounds untrusted warning strings and does not invent a truncated source pointer', () => {
    const spec = document({ $schema: `https://example.invalid/${'x'.repeat(5_000)}`, type: 'string' });
    const result = analyzeCompatibility(spec, spec).coverage!;
    expect(result.truncated).toBe(true);
    expect(result.warnings.every((warning) => warning.message.length <= 1_000 && warning.location.length <= 2_000)).toBe(true);
  });

  it('does not interpret a property named $ref as a reference object', () => {
    const spec = document({ type: 'object', properties: { $ref: { type: 'string' } } });
    expect(analyzeCompatibility(spec, spec).changes).toEqual([]);
    expect(analyzeCompatibility(spec, spec).coverage?.status).toBe('complete');
  });

  it('warns on recursion while preserving known non-recursive field comparisons', () => {
    const before = document({ $ref: '#/components/schemas/Node' });
    before.components = { schemas: { Node: { type: 'object', properties: { value: { type: 'string' }, next: { $ref: '#/components/schemas/Node' } } } } };
    const after = structuredClone(before);
    after.components.schemas.Node.properties.value.type = 'number';
    const result = analyzeCompatibility(before, after);
    expect(result.summary.breaking).toBe(1);
    expect(result.coverage?.warnings.some((warning) => warning.code === 'RECURSIVE_REFERENCE')).toBe(true);
  });
});
