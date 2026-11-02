import type { OpenApiDocument } from './types.js';

type Schema = Record<string, unknown>;

export const OAS31_DIALECT = 'https://spec.openapis.org/oas/3.1/dialect/base';
const KNOWN_DIALECTS = new Set([OAS31_DIALECT, 'https://json-schema.org/draft/2020-12/schema']);
const annotations = new Set(['title', 'description', 'summary', 'example', 'examples', 'default', 'deprecated', '$comment', 'externalDocs', 'xml']);
const simpleKeys = new Set(['type', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties', ...annotations]);
const lowerKeys = new Set(['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties']);
const upperKeys = new Set(['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties']);
const unsafeSchemas = new WeakMap<OpenApiDocument, WeakSet<object>>();
const unsafeDocuments = new WeakSet<OpenApiDocument>();

export function isOas30(document: OpenApiDocument): boolean { return document.openapi.startsWith('3.0.'); }

export function dialectFor(document: OpenApiDocument): string {
  return isOas30(document) ? 'openapi-3.0' : typeof document.jsonSchemaDialect === 'string' ? document.jsonSchemaDialect : OAS31_DIALECT;
}

export function supportedDialect(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && KNOWN_DIALECTS.has(value.replace(/#$/, '')));
}

/** Explicit type restrictions only: object/array keywords do not imply a type. */
export function normalizedSchemaTypes(document: OpenApiDocument, schema: Schema): Set<string> {
  const types = new Set<string>();
  if (typeof schema.type === 'string') types.add(schema.type);
  if (!isOas30(document) && Array.isArray(schema.type)) {
    for (const type of schema.type) if (typeof type === 'string') types.add(type);
  }
  if (isOas30(document) && typeof schema.type === 'string' && schema.nullable === true) types.add('null');
  return types;
}

export function markUnanalysedSchema(document: OpenApiDocument, value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  let nodes = unsafeSchemas.get(document);
  if (!nodes) { nodes = new WeakSet(); unsafeSchemas.set(document, nodes); }
  nodes.add(value);
}

export function markUnanalysedDocument(document: OpenApiDocument): void { unsafeDocuments.add(document); }

export function isUnanalysedSchema(document: OpenApiDocument, value: unknown): boolean {
  if (value !== undefined && (Array.isArray(value) || value === null || !['object', 'boolean'].includes(typeof value))) return true;
  if (isOas30(document) && typeof value === 'boolean') return true;
  return unsafeDocuments.has(document) || (!isOas30(document) && !supportedDialect(document.jsonSchemaDialect))
    || (typeof value === 'object' && value !== null && unsafeSchemas.get(document)?.has(value) === true);
}

/** Conjoin a deliberately small, context-independent primitive constraint subset.
 * Object applicators are not flattened: adjacent-keyword evaluation can change
 * additionalProperties/unevaluatedProperties semantics when allOf is removed.
 */
export function conjoinSchemaSiblings(target: unknown, siblings: Schema): unknown {
  if (target === false) return false;
  if (target === true) return siblings;
  if (!record(target)) return { allOf: [target, siblings] };
  const validationSiblings = Object.keys(siblings).filter((key) => !annotations.has(key));
  if (validationSiblings.length === 0) return { ...target, ...siblings };
  if (!Object.keys(target).every((key) => simpleKeys.has(key)) || !Object.keys(siblings).every((key) => simpleKeys.has(key))) {
    return { allOf: [target, siblings] };
  }
  const merged: Schema = { ...target };
  for (const [key, value] of Object.entries(siblings)) {
    if (!(key in merged) || annotations.has(key)) { merged[key] = value; continue; }
    const before = merged[key];
    if (JSON.stringify(before) === JSON.stringify(value)) continue;
    if (key === 'type') {
      const left = typeList(before); const right = typeList(value);
      if (!left || !right) return { allOf: [target, siblings] };
      const common = left.flatMap((type) => right.flatMap((other) => type === other ? [type]
        : (type === 'integer' && other === 'number') || (type === 'number' && other === 'integer') ? ['integer'] : []));
      const types = [...new Set(common)];
      if (!types.length) return false;
      merged.type = types.length === 1 ? types[0] : types.sort();
    } else if (key === 'enum' && Array.isArray(before) && Array.isArray(value)) {
      merged.enum = before.filter((item) => value.some((other) => jsonEqual(item, other)));
      if ((merged.enum as unknown[]).length === 0) return false;
    } else if (key === 'const') {
      if (!jsonEqual(before, value)) return false;
    } else if (lowerKeys.has(key) && typeof before === 'number' && typeof value === 'number') {
      merged[key] = Math.max(before, value);
    } else if (upperKeys.has(key) && typeof before === 'number' && typeof value === 'number') {
      merged[key] = Math.min(before, value);
    } else return { allOf: [target, siblings] };
  }
  if (merged.const !== undefined && Array.isArray(merged.enum) && !merged.enum.some((item) => jsonEqual(item, merged.const))) return false;
  return merged;
}

function typeList(value: unknown): string[] | undefined {
  return typeof value === 'string' ? [value] : Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
}
function record(value: unknown): value is Schema { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function jsonEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]));
  if (record(left) && record(right)) {
    const keys = Object.keys(left).sort(); const other = Object.keys(right).sort();
    return keys.length === other.length && keys.every((key, index) => key === other[index] && jsonEqual(left[key], right[key]));
  }
  return left === right;
}
