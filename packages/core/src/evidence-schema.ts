import { resolveLocalRef } from './parser.js';
import { supportedDialect } from './dialect.js';
import type { EvidenceIssue, EvidenceValidation } from './evidence-types.js';
import type { OpenApiDocument } from './types.js';

type Schema = Record<string, unknown>;
type Direction = 'request' | 'response' | 'expectation';
export interface EvidenceValidationOptions { document?: OpenApiDocument; direction?: Direction }

const MAX_DEPTH = 64;
const MAX_STEPS = 10_000;
const MAX_ISSUES = 40;
const MAX_TEXT = 1024 * 1024;
const TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
const ANNOTATIONS = new Set(['title', 'description', 'summary', 'default', 'example', 'examples', 'deprecated', '$comment', 'externalDocs', 'xml', 'readOnly', 'writeOnly']);
const KEYS = new Set(['type', 'enum', 'const', 'nullable', 'required', 'properties', 'additionalProperties', 'items', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'uniqueItems', 'allOf', 'anyOf', 'oneOf', 'not', '$ref', '$schema', '$defs', ...ANNOTATIONS]);
const NONNEGATIVE_INTEGERS = ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'];
const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);
function record(value: unknown): value is Schema { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function pointer(path: string, key: string | number): string { return `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`.slice(0, 512); }
function result(status: EvidenceValidation['status'], code?: string, path = '', message = ''): EvidenceValidation {
  return { status, issues: code ? [{ code, path, message }] : [], truncated: false };
}
function combine(results: EvidenceValidation[]): EvidenceValidation {
  const status = results.some((item) => item.status === 'invalid') ? 'invalid' : results.some((item) => item.status === 'unknown') ? 'unknown' : 'valid';
  const issues = results.flatMap((item) => item.issues);
  return { status, issues: issues.slice(0, MAX_ISSUES), truncated: issues.length > MAX_ISSUES || results.some((item) => item.truncated) };
}

/** Bounded, deliberately conservative validation of submitted JSON examples.
 * It makes no network calls, performs no coercion and does not execute patterns.
 * `valid` means only that this example satisfies the implemented schema profile.
 */
export function validateEvidenceValue(value: unknown, schema: unknown, options: EvidenceValidationOptions = {}): EvidenceValidation {
  const direction = options.direction ?? 'expectation';
  const oas30 = direction !== 'expectation' && options.document?.openapi.startsWith('3.0.') === true;
  const document = direction === 'expectation' ? schema as OpenApiDocument : options.document;
  let steps = 0;
  const budget = Symbol('evidence-budget');
  const charge = (depth = 0): void => { if (++steps > MAX_STEPS || depth > MAX_DEPTH) throw budget; };
  const unknown = (code: string, path: string, message: string): EvidenceValidation => result('unknown', code, path, message);
  const invalid = (code: string, path: string, message: string): EvidenceValidation => result('invalid', code, path, message);

  // Preflight JSON identity before comparisons. Cycles, accessors, prototypes,
  // sparse arrays and non-finite numbers are not portable evidence values.
  function inspectJson(input: unknown, depth: number, ancestors: Set<object>): boolean {
    charge(depth);
    if (input === null || typeof input === 'boolean') return true;
    if (typeof input === 'number') return Number.isFinite(input);
    if (typeof input === 'string') return input.length <= MAX_TEXT;
    if (typeof input !== 'object') return false;
    if (ancestors.has(input)) return false;
    if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) return false;
    if (Object.getOwnPropertySymbols(input).length) return false;
    const children = new Set(ancestors); children.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Object.values(descriptors).some((entry) => entry.get || entry.set)) return false;
    if (Object.entries(descriptors).some(([key, entry]) => !entry.enumerable && !(Array.isArray(input) && key === 'length'))) return false;
    if (Array.isArray(input) && (Object.keys(input).length !== input.length || !Object.keys(input).every((key) => /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < input.length))) return false;
    return Object.keys(input).every((key) => key.length <= 512 && inspectJson((input as Schema)[key], depth + 1, children));
  }

  function equal(left: unknown, right: unknown): boolean {
    charge();
    if (left === right) return true;
    if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => equal(item, right[index]));
    if (record(left) && record(right)) {
      const keys = Object.keys(left);
      return keys.length === Object.keys(right).length && keys.every((key) => own(right, key) && equal(left[key], right[key]));
    }
    return false;
  }

  // Validate shapes even below an absent property or an unselected branch.
  // An invalid schema is never accepted merely because a value skipped it.
  function shape(input: unknown, depth: number): boolean {
    charge(depth);
    if (typeof input === 'boolean') return !oas30;
    if (!record(input)) return false;
    if (oas30 && own(input, '$ref')) return typeof input.$ref === 'string';
    if (own(input, 'type')) {
      const types = typeof input.type === 'string' ? [input.type] : !oas30 && Array.isArray(input.type) ? input.type : [];
      if (!types.length || !types.every((type) => typeof type === 'string' && TYPES.has(type) && (!oas30 || type !== 'null')) || new Set(types).size !== types.length) return false;
    }
    if (own(input, 'enum') && (!Array.isArray(input.enum) || input.enum.length === 0)) return false;
    if (own(input, 'required') && (!Array.isArray(input.required) || !input.required.every((key) => typeof key === 'string') || new Set(input.required).size !== input.required.length)) return false;
    for (const key of NONNEGATIVE_INTEGERS) if (own(input, key) && (!Number.isSafeInteger(input[key]) || Number(input[key]) < 0)) return false;
    for (const key of ['minimum', 'maximum', 'multipleOf']) if (own(input, key) && (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || key === 'multipleOf' && Number(input[key]) <= 0)) return false;
    for (const key of ['exclusiveMinimum', 'exclusiveMaximum']) if (own(input, key) && (oas30 ? typeof input[key] !== 'boolean' : typeof input[key] !== 'number' || !Number.isFinite(input[key]))) return false;
    for (const key of ['readOnly', 'writeOnly', 'nullable', 'uniqueItems', 'deprecated']) if (own(input, key) && typeof input[key] !== 'boolean') return false;
    for (const key of ['$ref', '$schema', '$id', '$anchor', '$dynamicRef', 'pattern', 'format', 'title', 'description', 'summary', '$comment']) if (own(input, key) && typeof input[key] !== 'string') return false;
    if (own(input, 'examples') && !Array.isArray(input.examples)) return false;
    for (const key of ['externalDocs', 'xml']) if (own(input, key) && !record(input[key])) return false;
    for (const key of ['properties', '$defs', 'patternProperties']) {
      if (!own(input, key)) continue;
      if (!record(input[key]) || !Object.values(input[key]).every((child) => shape(child, depth + 1))) return false;
    }
    for (const key of ['additionalProperties', 'items', 'not', 'contains', 'if', 'then', 'else', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames']) {
      if (!own(input, key)) continue;
      // additionalProperties is explicitly allowed to be boolean in OpenAPI 3.0.
      if (key === 'additionalProperties' && typeof input[key] === 'boolean') continue;
      if (!shape(input[key], depth + 1)) return false;
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
      if (!own(input, key)) continue;
      const children = input[key];
      if (!Array.isArray(children) || children.length === 0 || !children.every((child) => shape(child, depth + 1))) return false;
    }
    return true;
  }

  function typeMatches(sample: unknown, type: string): boolean {
    if (type === 'null') return sample === null;
    if (type === 'object') return record(sample);
    if (type === 'array') return Array.isArray(sample);
    if (type === 'integer') return typeof sample === 'number' && Number.isInteger(sample);
    return typeof sample === type;
  }

  function annotation(input: unknown, key: string, depth = 0): boolean | 'unknown' {
    charge(depth);
    if (!record(input)) return false;
    if (own(input, '$id') || own(input, '$schema') && !supportedDialect(input.$schema)) return 'unknown';
    if (typeof input.$ref === 'string' && document) {
      try {
        const referenced = annotation(resolveLocalRef(document, input.$ref), key, depth + 1);
        if (oas30) return referenced;
        if (referenced === 'unknown' || referenced === true && input[key] === false) return 'unknown';
        if (referenced === true) return true;
      } catch (error) { if (error === budget) throw error; return 'unknown'; }
    }
    const values = Array.isArray(input.allOf) ? input.allOf.map((child) => annotation(child, key, depth + 1)) : [];
    if (values.includes('unknown') || input[key] === false && values.includes(true)) return 'unknown';
    return input[key] === true || values.includes(true);
  }

  function visit(sample: unknown, input: unknown, path: string, depth: number): EvidenceValidation {
    charge(depth);
    if (typeof input === 'boolean') return input ? result('valid') : invalid('FALSE_SCHEMA', path, 'The schema rejects every value.');
    if (!record(input)) return unknown('MISSING_SCHEMA', path, 'A usable schema was not supplied.');
    if (own(input, '$schema') && !supportedDialect(input.$schema)) return unknown('UNSUPPORTED_DIALECT', path, 'The schema dialect is outside the supported evidence profile.');
    if (own(input, '$id')) return unknown('SCOPED_SCHEMA_UNSUPPORTED', path, 'Schema identifier scope is not resolved by evidence validation.');
    const outcomes: EvidenceValidation[] = [];
    if (own(input, '$ref')) {
      if (!document) return unknown('UNRESOLVED_REFERENCE', path, 'A document is required to resolve this schema reference.');
      try {
        const referenced = resolveLocalRef(document, input.$ref as string);
        if (!shape(referenced, depth + 1)) return unknown('INVALID_SCHEMA', path, 'The referenced schema has unsupported or invalid keyword shapes.');
        const checked = visit(sample, referenced, path, depth + 1);
        if (oas30) return checked;
        outcomes.push(checked);
      } catch (error) {
        if (error === budget) throw error;
        outcomes.push(unknown('UNRESOLVED_REFERENCE', path, 'The schema reference could not be resolved locally.'));
      }
    }
    for (const key of Object.keys(input)) {
      if (!KEYS.has(key) && !key.startsWith('x-')) outcomes.push(unknown('UNSUPPORTED_KEYWORD', path, `Schema keyword ${key.slice(0, 64)} is outside the evidence validation profile.`));
    }
    if (!oas30 && own(input, 'nullable')) outcomes.push(unknown('UNSUPPORTED_KEYWORD', path, 'nullable is not a JSON Schema 2020-12 type constraint.'));
    if (oas30 && own(input, 'nullable') && input.nullable === true && typeof input.type !== 'string') outcomes.push(unknown('NULLABLE_WITHOUT_TYPE', path, 'OpenAPI 3.0 nullable needs an explicit type.'));
    if (oas30 && own(input, 'const')) outcomes.push(unknown('UNSUPPORTED_KEYWORD', path, 'const is outside the OpenAPI 3.0 Schema Object profile.'));
    if (oas30 && own(input, '$defs')) outcomes.push(unknown('UNSUPPORTED_KEYWORD', path, '$defs is outside the OpenAPI 3.0 Schema Object profile.'));
    if (oas30 && own(input, '$schema')) outcomes.push(unknown('UNSUPPORTED_KEYWORD', path, '$schema is outside the OpenAPI 3.0 Schema Object profile.'));

    if (own(input, 'type')) {
      const types: string[] = typeof input.type === 'string' ? [input.type] : input.type as string[];
      const nullable = oas30 && typeof input.type === 'string' && input.nullable === true && sample === null;
      if (!nullable && !types.some((type) => typeMatches(sample, type))) outcomes.push(invalid('TYPE_MISMATCH', path, 'The value does not have an allowed schema type.'));
    }
    if (Array.isArray(input.enum) && !input.enum.some((entry) => equal(entry, sample))) outcomes.push(invalid('ENUM_MISMATCH', path, 'The value is not an allowed enum member.'));
    if (!oas30 && own(input, 'const') && !equal(input.const, sample)) outcomes.push(invalid('CONST_MISMATCH', path, 'The value does not satisfy the constant constraint.'));

    if (typeof sample === 'number') {
      if (typeof input.minimum === 'number' && (sample < input.minimum || oas30 && input.exclusiveMinimum === true && sample === input.minimum)) outcomes.push(invalid('MINIMUM', path, 'The number is below the allowed lower bound.'));
      if (typeof input.maximum === 'number' && (sample > input.maximum || oas30 && input.exclusiveMaximum === true && sample === input.maximum)) outcomes.push(invalid('MAXIMUM', path, 'The number exceeds the allowed upper bound.'));
      if (!oas30 && typeof input.exclusiveMinimum === 'number' && sample <= input.exclusiveMinimum) outcomes.push(invalid('EXCLUSIVE_MINIMUM', path, 'The number does not exceed the exclusive lower bound.'));
      if (!oas30 && typeof input.exclusiveMaximum === 'number' && sample >= input.exclusiveMaximum) outcomes.push(invalid('EXCLUSIVE_MAXIMUM', path, 'The number is not below the exclusive upper bound.'));
      // Exact decimal multiple arithmetic is deliberately not approximated.
      if (typeof input.multipleOf === 'number') {
        if (Number.isSafeInteger(sample) && Number.isSafeInteger(input.multipleOf)) {
          if (sample % input.multipleOf !== 0) outcomes.push(invalid('MULTIPLE_OF', path, 'The number is not a multiple of the required increment.'));
        } else outcomes.push(unknown('DECIMAL_MULTIPLE_UNSUPPORTED', path, 'Decimal multipleOf validation requires exact decimal arithmetic.'));
      }
    }
    if (typeof sample === 'string') {
      const length = Array.from(sample).length;
      if (typeof input.minLength === 'number' && length < input.minLength) outcomes.push(invalid('MIN_LENGTH', path, 'The text is shorter than the minimum character length.'));
      if (typeof input.maxLength === 'number' && length > input.maxLength) outcomes.push(invalid('MAX_LENGTH', path, 'The text exceeds the maximum character length.'));
    }
    if (Array.isArray(sample)) {
      if (typeof input.minItems === 'number' && sample.length < input.minItems) outcomes.push(invalid('MIN_ITEMS', path, 'The array contains fewer items than allowed.'));
      if (typeof input.maxItems === 'number' && sample.length > input.maxItems) outcomes.push(invalid('MAX_ITEMS', path, 'The array contains more items than allowed.'));
      if (input.uniqueItems === true) {
        let duplicate = false;
        for (let index = 0; index < sample.length && !duplicate; index++) for (let other = 0; other < index; other++) if (equal(sample[index], sample[other])) { duplicate = true; break; }
        if (duplicate) outcomes.push(invalid('UNIQUE_ITEMS', path, 'The array contains duplicate items.'));
      }
      // prefixItems changes the portion of an array governed by items.
      if (own(input, 'items') && !own(input, 'prefixItems')) for (let index = 0; index < sample.length; index++) outcomes.push(visit(sample[index], input.items, pointer(path, index), depth + 1));
    }
    if (record(sample)) {
      const keys = Object.keys(sample);
      if (typeof input.minProperties === 'number' && keys.length < input.minProperties) outcomes.push(invalid('MIN_PROPERTIES', path, 'The object has fewer properties than allowed.'));
      if (typeof input.maxProperties === 'number' && keys.length > input.maxProperties) outcomes.push(invalid('MAX_PROPERTIES', path, 'The object has more properties than allowed.'));
      const properties = record(input.properties) ? input.properties : {};
      if (Array.isArray(input.required)) for (const key of input.required as string[]) {
        const child = own(properties, key) ? properties[key] : undefined;
        const exempt = direction === 'request' ? annotation(child, 'readOnly') : direction === 'response' ? annotation(child, 'writeOnly') : false;
        if (!own(sample, key)) {
          if (exempt === 'unknown') outcomes.push(unknown('DIRECTION_ANNOTATION_UNPROVEN', pointer(path, key), 'The directional required-property annotation could not be resolved.'));
          else if (!exempt) outcomes.push(invalid('REQUIRED_PROPERTY', pointer(path, key), 'A required property is missing.'));
        }
      }
      for (const key of keys) {
        if (own(properties, key)) outcomes.push(visit(sample[key], properties[key], pointer(path, key), depth + 1));
        else if (!own(input, 'patternProperties') && input.additionalProperties === false) outcomes.push(invalid('ADDITIONAL_PROPERTY', pointer(path, key), 'The schema does not allow this additional property.'));
        else if (!own(input, 'patternProperties') && record(input.additionalProperties)) outcomes.push(visit(sample[key], input.additionalProperties, pointer(path, key), depth + 1));
      }
    }
    if (Array.isArray(input.allOf)) outcomes.push(combine(input.allOf.map((branch) => visit(sample, branch, path, depth + 1))));
    for (const key of ['anyOf', 'oneOf'] as const) {
      const branches = input[key];
      if (!Array.isArray(branches)) continue;
      const checked = branches.map((branch) => visit(sample, branch, path, depth + 1));
      const valid = checked.filter((item) => item.status === 'valid').length;
      const uncertain = checked.some((item) => item.status === 'unknown');
      if (key === 'anyOf') {
        if (valid === 0) outcomes.push(uncertain ? unknown('ANY_OF_UNPROVEN', path, 'No alternative is proven to accept this value.') : invalid('ANY_OF_NO_MATCH', path, 'The value does not satisfy any schema alternative.'));
      } else if (valid > 1) outcomes.push(invalid('ONE_OF_MULTIPLE_MATCHES', path, 'The value satisfies more than one exclusive schema alternative.'));
      else if (uncertain) outcomes.push(unknown('ONE_OF_UNPROVEN', path, 'Exactly one matching schema alternative could not be established.'));
      else if (valid === 0) outcomes.push(invalid('ONE_OF_NO_MATCH', path, 'The value does not satisfy an exclusive schema alternative.'));
    }
    if (own(input, 'not')) {
      const checked = visit(sample, input.not, path, depth + 1);
      if (checked.status === 'valid') outcomes.push(invalid('NOT_MATCHED', path, 'The value matches a forbidden schema.'));
      else if (checked.status === 'unknown') outcomes.push(unknown('NOT_UNPROVEN', path, 'The forbidden schema could not be evaluated conclusively.'));
    }
    return combine(outcomes);
  }

  try {
    if (!inspectJson(value, 0, new Set())) return unknown('NON_JSON_EVIDENCE', '', 'Evidence must contain finite, acyclic, plain JSON values.');
    steps = 0;
    if (schema === undefined) return unknown('MISSING_SCHEMA', '', 'A usable schema was not supplied.');
    if (!inspectJson(schema, 0, new Set())) return unknown('NON_JSON_SCHEMA', '', 'The schema must contain finite, acyclic, plain JSON values.');
    steps = 0;
    if (!shape(schema, 0)) return unknown('INVALID_SCHEMA', '', 'The schema has unsupported or invalid keyword shapes.');
    if (direction !== 'expectation' && options.document && !oas30 && !supportedDialect(options.document.jsonSchemaDialect)) return unknown('UNSUPPORTED_DIALECT', '', 'The document schema dialect is outside the supported evidence profile.');
    steps = 0;
    return visit(value, schema, '', 0);
  } catch (error) {
    if (error === budget) return { status: 'unknown', issues: [{ code: 'EVIDENCE_LIMIT', path: '', message: 'Evidence validation exceeded its bounded depth or work budget.' }], truncated: true };
    return unknown('EVIDENCE_VALIDATION_UNAVAILABLE', '', 'The evidence could not be validated safely.');
  }
}
