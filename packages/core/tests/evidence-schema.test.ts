import { describe, expect, it } from 'vitest';
import { validateEvidenceValue as validate } from '../src/evidence-schema.js';
import { prepareContract } from '../src/bundle.js';
import type { OpenApiDocument } from '../src/types.js';

const v30: OpenApiDocument = { openapi: '3.0.4', paths: {} };
const v31: OpenApiDocument = { openapi: '3.1.0', paths: {} };

describe('consumer evidence schema validation', () => {
  it('checks typed objects, decoded values and nested JSON Pointer locations without coercion', () => {
    const schema = { type: 'object', required: ['count'], properties: { count: { type: 'integer', minimum: 1 }, 'a/b~c': { type: 'boolean' } }, additionalProperties: false };
    expect(validate({ count: 2, 'a/b~c': true }, schema).status).toBe('valid');
    const report = validate({ count: '2', 'a/b~c': 'yes', secret: 'do-not-persist' }, schema);
    expect(report.status).toBe('invalid');
    expect(report.issues.map((issue) => issue.path)).toEqual(['/count', '/a~1b~0c', '/secret']);
    expect(JSON.stringify(report)).not.toContain('do-not-persist');
    expect(validate({}, schema).issues[0]?.code).toBe('REQUIRED_PROPERTY');
  });

  it('applies object and array constraints only to the corresponding types', () => {
    expect(validate('text', { required: ['id'], properties: { id: { type: 'number' } }, additionalProperties: false }).status).toBe('valid');
    expect(validate(3, { items: { type: 'string' }, minItems: 2 }).status).toBe('valid');
    expect(validate([], { type: 'object' }).status).toBe('invalid');
    expect(validate(null, { type: 'object' }).status).toBe('invalid');
  });

  it('compares JSON enum/const structurally, independent of object key order', () => {
    expect(validate({ b: 2, a: 1 }, { enum: [{ a: 1, b: 2 }] }).status).toBe('valid');
    expect(validate({ b: 2, a: 1 }, { const: { a: 1, b: 2 } }).status).toBe('valid');
    expect(validate([2, 1], { enum: [[1, 2]] }).status).toBe('invalid');
    expect(validate(null, { const: null }).status).toBe('valid');
    expect(validate('abc', { const: 'def' }, { document: v30, direction: 'request' }).status).toBe('unknown');
  });

  it('uses Unicode character counts and numeric/integer bounds', () => {
    expect(validate('😀', { type: 'string', minLength: 1, maxLength: 1 }).status).toBe('valid');
    expect(validate('a😀', { maxLength: 1 }).status).toBe('invalid');
    expect(validate(1.5, { type: 'integer' }).status).toBe('invalid');
    expect(validate(10, { minimum: 10, maximum: 10 }).status).toBe('valid');
    expect(validate(10, { exclusiveMinimum: 10 }).status).toBe('invalid');
    expect(validate(10, { exclusiveMaximum: 10 }).status).toBe('invalid');
    expect(validate(10, { minimum: 10, exclusiveMinimum: true }, { document: v30, direction: 'request' }).status).toBe('invalid');
    expect(validate(10, { minimum: 10, exclusiveMinimum: false }, { document: v30, direction: 'request' }).status).toBe('valid');
    expect(validate(10, { exclusiveMinimum: true }, { document: v31, direction: 'request' }).status).toBe('unknown');
  });

  it('handles integer multiples exactly and does not invent decimal precision', () => {
    expect(validate(12, { multipleOf: 3 }).status).toBe('valid');
    expect(validate(13, { multipleOf: 3 }).status).toBe('invalid');
    expect(validate(0.3, { multipleOf: 0.1 }).status).toBe('unknown');
    expect(validate('unused', { multipleOf: 0.1 }).status).toBe('valid');
  });

  it('checks array items, uniqueness and collection size', () => {
    expect(validate([1, 2], { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2, uniqueItems: true }).status).toBe('valid');
    expect(validate([{ a: 1, b: 2 }, { b: 2, a: 1 }], { uniqueItems: true }).issues[0]?.code).toBe('UNIQUE_ITEMS');
    expect(validate([1, 'bad'], { items: { type: 'integer' } }).issues[0]?.path).toBe('/1');
    expect(validate({}, { minProperties: 1 }).status).toBe('invalid');
    expect(validate({ a: 1, b: 2 }, { maxProperties: 1 }).status).toBe('invalid');
  });

  it('applies boolean schemas only where the dialect supports them', () => {
    expect(validate(null, true).status).toBe('valid');
    expect(validate(null, false).status).toBe('invalid');
    expect(validate(null, true, { document: v30, direction: 'response' }).status).toBe('unknown');
    expect(validate({ a: 1 }, { additionalProperties: true }, { document: v30, direction: 'request' }).status).toBe('valid');
    expect(validate({ a: 1 }, { additionalProperties: false }, { document: v30, direction: 'request' }).status).toBe('invalid');
  });

  it('keeps OpenAPI 3.0 nullable directional and explicit', () => {
    expect(validate(null, { type: 'string', nullable: true }, { document: v30, direction: 'request' }).status).toBe('valid');
    expect(validate(null, { type: 'string', nullable: true, enum: ['a'] }, { document: v30, direction: 'request' }).status).toBe('invalid');
    expect(validate(null, { nullable: true }, { document: v30, direction: 'request' }).status).toBe('unknown');
    expect(validate(null, { type: ['string', 'null'] }, { document: v31, direction: 'request' }).status).toBe('valid');
    expect(validate('a', { type: 'string', nullable: true }, { document: v31, direction: 'request' }).status).toBe('unknown');
    expect(validate(null, { type: ['string', 'null'] }, { document: v30, direction: 'request' }).status).toBe('unknown');
  });

  it('uses directional readOnly/writeOnly exemptions without removing consumer expectations', () => {
    const schema = { type: 'object', required: ['id', 'secret'], properties: { id: { type: 'string', readOnly: true }, secret: { type: 'string', writeOnly: true } } };
    expect(validate({ secret: 'value' }, schema, { document: v30, direction: 'request' }).status).toBe('valid');
    expect(validate({ id: 'value' }, schema, { document: v31, direction: 'response' }).status).toBe('valid');
    expect(validate({ id: 'value' }, schema, { direction: 'expectation' }).status).toBe('invalid');
    expect(validate({}, schema, { document: v30, direction: 'request' }).issues.map((item) => item.path)).toEqual(['/secret']);
  });

  it('checks local schema references and distinguishes ignored 3.0 siblings from 3.1 conjunction', () => {
    const document: OpenApiDocument = { ...v31, components: { schemas: { Count: { type: 'integer', minimum: 0 } } } };
    const schema = { $ref: '#/components/schemas/Count', minimum: 5 };
    expect(validate(2, schema, { document, direction: 'request' }).status).toBe('invalid');
    expect(validate(2, schema, { document: { ...document, openapi: '3.0.4' }, direction: 'request' }).status).toBe('valid');
    expect(validate(2, { ...schema, type: { ignored: true } }, { document: { ...document, openapi: '3.0.4' }, direction: 'request' }).status).toBe('valid');
    expect(validate('x', schema, { document, direction: 'request' }).status).toBe('invalid');
    expect(validate(2, { $ref: 'https://example.invalid/schema' }, { document, direction: 'request' }).status).toBe('unknown');
  });

  it('supports finite recursive values against recursive local schemas', () => {
    const schema = { $defs: { Node: { type: 'object', required: ['value'], properties: { value: { type: 'integer' }, next: { $ref: '#/$defs/Node' } }, additionalProperties: false } }, $ref: '#/$defs/Node' };
    expect(validate({ value: 1, next: { value: 2 } }, schema).status).toBe('valid');
    expect(validate({ value: 1, next: { value: 'bad' } }, schema).issues[0]?.path).toBe('/next/value');
    const document: OpenApiDocument = { ...v31, components: { schemas: { ReadOnly: { type: 'string', readOnly: true } } } };
    const required = { required: ['id'], properties: { id: { $ref: '#/components/schemas/ReadOnly' } } };
    expect(validate({}, required, { document, direction: 'request' }).status).toBe('valid');
  });

  it('bounds circular references including directional annotation lookup', () => {
    const document: OpenApiDocument = { ...v31, components: { schemas: { Loop: { $ref: '#/components/schemas/Loop' } } } };
    expect(validate('x', { $ref: '#/components/schemas/Loop' }, { document, direction: 'request' })).toMatchObject({ status: 'unknown', truncated: true });
    expect(validate({}, { required: ['id'], properties: { id: { $ref: '#/components/schemas/Loop' } } }, { document, direction: 'request' })).toMatchObject({ status: 'unknown', truncated: true });
  });

  it('evaluates prepared multi-file reference graphs', () => {
    const prepared = prepareContract({ kind: 'bundle', entry: 'openapi.json', files: [
      { path: 'openapi.json', content: JSON.stringify({ ...v31, components: { schemas: { Body: { $ref: './schema.json' } } } }) },
      { path: 'schema.json', content: JSON.stringify({ type: 'object', required: ['count'], properties: { count: { type: 'integer', minimum: 2 } } }) },
    ] });
    expect(validate({ count: 1 }, { $ref: '#/components/schemas/Body' }, { document: prepared.document, direction: 'request' }).status).toBe('invalid');
    expect(validate({ count: 2 }, { $ref: '#/components/schemas/Body' }, { document: prepared.document, direction: 'request' }).status).toBe('valid');
  });

  it('uses sound three-valued logic for conjunction, alternatives and negation', () => {
    expect(validate('x', { allOf: [{ type: 'string' }, { minLength: 2 }] }).status).toBe('invalid');
    expect(validate('x', { anyOf: [{ type: 'string' }, { pattern: '.*' }] }).status).toBe('valid');
    expect(validate('x', { anyOf: [{ type: 'number' }, { pattern: '.*' }] }).status).toBe('unknown');
    expect(validate('x', { anyOf: [{ type: 'number' }, { type: 'boolean' }] }).status).toBe('invalid');
    expect(validate('x', { oneOf: [{ type: 'string' }, { pattern: '.*' }] }).status).toBe('unknown');
    expect(validate('x', { oneOf: [{ type: 'string' }, { minLength: 1 }] }).status).toBe('invalid');
    expect(validate('x', { oneOf: [{ type: 'string' }, { type: 'number' }] }).status).toBe('valid');
    expect(validate('x', { not: { type: 'number' } }).status).toBe('valid');
    expect(validate('x', { not: { type: 'string' } }).status).toBe('invalid');
    expect(validate('x', { not: { pattern: '.*' } }).status).toBe('unknown');
  });

  it('preserves uncertainty for unsupported validation and custom dialects', () => {
    for (const schema of [{ format: 'uuid' }, { pattern: '(a+)+$' }, { dependentRequired: { a: ['b'] } }, { unevaluatedProperties: false }, { $dynamicRef: '#node' }, { 'custom-rule': true }]) {
      expect(validate('x', schema).status).toBe('unknown');
    }
    expect(validate('wrong', { type: 'number', format: 'double' }).status).toBe('invalid');
    expect(validate('x', { type: 'number', $schema: 'https://example.invalid/dialect' }).status).toBe('unknown');
    expect(validate('x', { type: 'number' }, { document: { ...v31, jsonSchemaDialect: 'https://example.invalid/dialect' }, direction: 'request' }).status).toBe('unknown');
    expect(validate('x', { type: 'string', $schema: 'https://json-schema.org/draft/2020-12/schema' }).status).toBe('valid');
    expect(validate('x', { type: 'string', $id: 'https://example.invalid/schema' }).status).toBe('unknown');
  });

  it('never misuses additionalProperties or items when unsupported applicators alter their scope', () => {
    expect(validate({ key: 1 }, { patternProperties: { '^key$': { type: 'number' } }, additionalProperties: false }).status).toBe('unknown');
    expect(validate({ key: 1 }, { patternProperties: { '^key$': { type: 'number' } }, additionalProperties: { type: 'string' } }).status).toBe('unknown');
    expect(validate(['first', 2], { prefixItems: [{ type: 'string' }], items: { type: 'number' } }).status).toBe('unknown');
  });

  it('rejects malformed keyword shapes even under missing properties and unmatched alternatives', () => {
    for (const schema of [null, [], { type: 'imaginary' }, { type: [] }, { enum: [] }, { minLength: -1 }, { minimum: '0' }, { required: ['a', 'a'] }, { properties: { absent: null } }, { anyOf: [true, { items: [] }] }, { allOf: [] }, { readOnly: 'true' }, { multipleOf: 0 }, { title: 1 }, { deprecated: 'yes' }, { examples: 'example' }]) {
      expect(validate({}, schema).status).toBe('unknown');
    }
    expect(validate({}, undefined).issues[0]?.code).toBe('MISSING_SCHEMA');
  });

  it('does not resolve inherited property names or mutate prototypes', () => {
    const schema = JSON.parse('{"required":["__proto__"],"properties":{"__proto__":{"type":"string"}},"additionalProperties":false}');
    expect(validate({}, schema).status).toBe('invalid');
    expect(validate(JSON.parse('{"__proto__":"safe"}'), schema).status).toBe('valid');
    expect(validate('x', { $ref: '#/$defs/toString', $defs: {} }).status).toBe('unknown');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects non-JSON examples and cyclic schemas without evaluating accessors', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const disguisedHole = new Array(1); (disguisedHole as any).extra = 1;
    const hidden = Object.defineProperty({}, 'id', { value: 1 });
    const symbol = { [Symbol('value')]: 1 };
    for (const sample of [undefined, Number.NaN, Number.POSITIVE_INFINITY, new Date(), new Array(2), disguisedHole, hidden, symbol, cyclic]) expect(validate(sample, {}).status).toBe('unknown');
    expect(validate('x', cyclic).status).toBe('unknown');
    let accessed = false;
    const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { accessed = true; return 'secret'; } });
    expect(validate(getter, {}).status).toBe('unknown');
    expect(accessed).toBe(false);
  });

  it('bounds issue output and resource use without silently marking work as complete', () => {
    const required = Array.from({ length: 60 }, (_, index) => `key${index}`);
    const result = validate({}, { required });
    expect(result.status).toBe('invalid');
    expect(result.issues).toHaveLength(40);
    expect(result.truncated).toBe(true);
    expect(validate(Array.from({ length: 10_001 }, () => 1), {})).toMatchObject({ status: 'unknown', truncated: true });
    let deep: unknown = 1; for (let index = 0; index < 70; index++) deep = [deep];
    expect(validate(deep, {})).toMatchObject({ status: 'unknown', truncated: true });
  });
});
