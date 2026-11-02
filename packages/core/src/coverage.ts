import type { AnalysisCoverage, CoverageWarning, OpenApiDocument } from './types.js';
import { locateContractSource } from './bundle.js';
import { dialectFor, isOas30, markUnanalysedDocument, markUnanalysedSchema, supportedDialect } from './dialect.js';
import { pathItemReferenceConflicts, resolveNode, resolvePathItemNode, resolveSchemaNode } from './parser.js';

type Node = Record<string, unknown>;
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const PARTIAL_SCHEMA = new Set(['const', 'format', 'pattern', 'multipleOf', 'uniqueItems', 'contains', 'minContains', 'maxContains', 'prefixItems', 'not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'patternProperties', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems', 'contentEncoding', 'contentMediaType', 'contentSchema', 'discriminator']);
const UNSUPPORTED_BASE = new Set(['$id', '$anchor', '$dynamicAnchor', '$dynamicRef', '$recursiveAnchor', '$recursiveRef']);
const KNOWN_SCHEMA = new Set(['$ref', '$schema', '$defs', 'definitions', '$comment', 'type', 'nullable', 'enum', 'properties', 'required', 'items', 'additionalProperties', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'pattern', 'oneOf', 'anyOf', 'allOf', 'title', 'description', 'default', 'example', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'xml', 'externalDocs', ...PARTIAL_SCHEMA, ...UNSUPPORTED_BASE]);
const SCHEMA_MAPS = ['properties', 'patternProperties', 'dependentSchemas'];
const SCHEMA_CHILDREN = ['items', 'additionalProperties', 'contains', 'not', 'if', 'then', 'else', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'contentSchema'];

/** Known omissions of the implemented static profile, not a coverage percentage.
 * Inspect typed contract positions only; example/default JSON is never schema.
 */
export function inspectCoverage(oldDocument: OpenApiDocument, newDocument: OpenApiDocument): AnalysisCoverage {
  const warnings: CoverageWarning[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const add = (document: OpenApiDocument, side: 'old' | 'new', code: string, location: string, message: string): void => {
    const key = JSON.stringify([side, code, location]);
    if (seen.has(key)) return;
    seen.add(key);
    if (warnings.length >= 100) { truncated = true; return; }
    const originalSource = locateContractSource(document, location);
    const source = originalSource && originalSource.pointer.length <= 2_000 ? originalSource : undefined;
    if (location.length > 2_000 || message.length > 1_000 || (originalSource && !source)) truncated = true;
    warnings.push({ code, side, location: location.length > 2_000 ? `${location.slice(0, 1_997)}...` : location,
      message: message.length > 1_000 ? `${message.slice(0, 997)}...` : message, ...(source ? { source } : {}) });
  };

  for (const [side, document] of [['old', oldDocument], ['new', newDocument]] as const) {
    let budget = 5_000;
    const warning = (code: string, location: string, message: string): void => add(document, side, code, location, message);
    if (!isOas30(document) && !supportedDialect(document.jsonSchemaDialect)) {
      warning('UNSUPPORTED_SCHEMA_DIALECT', 'jsonSchemaDialect', `Schema dialect ${String(document.jsonSchemaDialect)} is not supported; schema comparisons are withheld.`);
      markUnanalysedDocument(document);
    }
    if (isOas30(document) && document.jsonSchemaDialect !== undefined) {
      warning('OAS30_DIALECT_FIELD_IGNORED', 'jsonSchemaDialect', 'jsonSchemaDialect is not an OpenAPI 3.0 field and does not select a schema dialect.');
    }
    if (record(document.webhooks) && Object.keys(document.webhooks).length) warning('WEBHOOKS_NOT_ANALYSED', 'webhooks', 'Webhook sender/receiver compatibility is not analysed by this release.');
    if (Array.isArray(document.servers) && document.servers.length) warning('SERVERS_NOT_ANALYSED', 'servers', 'Server URL and variable changes are outside the implemented static compatibility profile.');

    function consume(location: string, depth: number): boolean {
      if (--budget >= 0 && depth <= 128) return true;
      warning('COVERAGE_SCAN_LIMIT', location, 'Coverage inspection reached its node/depth budget; schema comparisons are withheld rather than claiming complete coverage.');
      markUnanalysedDocument(document);
      return false;
    }
    function generic(value: unknown, location: string, role: string, references: Set<string>): Node | undefined {
      if (!record(value)) return undefined;
      if (typeof value.$ref === 'string') {
        if (references.has(value.$ref)) { warning('RECURSIVE_REFERENCE', location, 'Recursive reference expansion is bounded; full recursive equivalence is not proven.'); return undefined; }
        const allowed = isOas30(document) ? ['$ref'] : ['$ref', 'summary', 'description'];
        if (Object.keys(value).some((key) => !allowed.includes(key))) warning('REFERENCE_SIBLINGS_IGNORED', location, `${role} Reference Object validation siblings are ignored under ${dialectFor(document)}; only permitted reference metadata is used.`);
        references.add(value.$ref);
      }
      const resolved = resolveNode(document, value);
      return record(resolved) ? resolved : undefined;
    }
    function schema(value: unknown, location: string, references: Set<string>, depth = 0): void {
      if (value === undefined || !consume(location, depth)) return;
      if (typeof value === 'boolean') {
        if (isOas30(document)) { warning('OAS30_BOOLEAN_SCHEMA', location, 'Boolean schemas are not part of the supported OpenAPI 3.0 Schema Object dialect.'); markUnanalysedSchema(document, value); }
        return;
      }
      if (!record(value)) { warning('INVALID_SCHEMA_SHAPE', location, 'This schema shape is not understood; schema comparison is withheld.'); markUnanalysedSchema(document, value); return; }
      const nextReferences = new Set(references);
      if (typeof value.$ref === 'string') {
        if (references.has(value.$ref)) { warning('RECURSIVE_REFERENCE', location, 'Recursive schemas are compared only to the bounded reference frontier, not proven equivalent in full.'); return; }
        nextReferences.add(value.$ref);
        if (isOas30(document) && Object.keys(value).some((key) => key !== '$ref')) warning('OAS30_SCHEMA_REF_SIBLINGS_IGNORED', location, 'OpenAPI 3.0 schema reference siblings are ignored; constraints must be placed in an explicit composition.');
      }
      const resolved = resolveSchemaNode(document, value);
      if (typeof resolved === 'boolean') {
        if (isOas30(document)) { warning('OAS30_BOOLEAN_SCHEMA', location, 'A referenced boolean schema is not supported in OpenAPI 3.0.'); markUnanalysedSchema(document, value); }
        return;
      }
      if (!record(resolved)) return;
      if (!isOas30(document) && typeof value.$ref === 'string' && Array.isArray(resolved.allOf)
        && Object.keys(value).some((key) => !['$ref', 'title', 'description', 'summary', 'example', 'examples', 'default', 'deprecated', '$comment', 'externalDocs', 'xml'].includes(key))) {
        warning('SCHEMA_REF_CONJUNCTION_PARTIAL', location, 'Schema reference siblings form a conjunction that cannot be safely flattened by the simple normalization profile; precise subtree comparison is withheld.');
        markUnanalysedSchema(document, value);
      }
      const dialectUnsupported = resolved.$schema !== undefined && (isOas30(document) || !supportedDialect(resolved.$schema));
      const baseUnsupported = Object.keys(resolved).some((key) => UNSUPPORTED_BASE.has(key));
      if (dialectUnsupported || baseUnsupported) {
        warning(dialectUnsupported ? 'UNSUPPORTED_SCHEMA_DIALECT' : 'SCHEMA_RESOURCE_SCOPE_UNSUPPORTED', location,
          dialectUnsupported ? `Schema dialect ${String(resolved.$schema)} is not supported at this location; subtree comparison is withheld.`
            : 'Schema resource identifiers, anchors or dynamic references require base/dynamic-scope semantics not implemented here; subtree comparison is withheld.');
        markUnanalysedSchema(document, value); markUnanalysedSchema(document, resolved);
        return;
      }
      if (isOas30(document) && (Array.isArray(resolved.type) || resolved.type === 'null')) {
        warning('OAS30_TYPE_SHAPE_UNSUPPORTED', `${location}.type`, 'OpenAPI 3.0 requires a single non-null type; use nullable with an explicit type. This subtree is not precisely compared.');
        markUnanalysedSchema(document, value); return;
      }
      if (!isOas30(document) && resolved.nullable !== undefined) warning('OAS31_NULLABLE_IGNORED', `${location}.nullable`, 'nullable is not a JSON Schema 2020-12 validation keyword; it does not add null to the type set in OpenAPI 3.1.');
      if (isOas30(document) && resolved.nullable === true && typeof resolved.type !== 'string') warning('NULLABLE_WITHOUT_EXPLICIT_TYPE', `${location}.nullable`, 'OpenAPI 3.0 nullable has an effect only beside an explicit type; no implicit object/array type is inferred.');
      for (const key of Object.keys(resolved)) {
        if (PARTIAL_SCHEMA.has(key)) warning('SCHEMA_KEYWORD_PARTIAL', `${location}.${key}`, `The ${key} keyword is retained but its full containment/runtime semantics are not proven by this profile.`);
        else if (!KNOWN_SCHEMA.has(key) && !key.startsWith('x-')) {
          warning('UNKNOWN_SCHEMA_KEYWORD', `${location}.${key}`, `Unknown schema keyword ${key}; its effect cannot be certified by this profile.`);
          markUnanalysedSchema(document, value);
        }
      }
      if (record(resolved.additionalProperties)) warning('SCHEMA_KEYWORD_PARTIAL', `${location}.additionalProperties`, 'Schema-valued additionalProperties containment is only partially analysed.');
      for (const keyword of ['oneOf', 'anyOf', 'allOf', 'prefixItems']) {
        if (!Array.isArray(resolved[keyword])) continue;
        warning('SCHEMA_COMPOSITION_PARTIAL', `${location}.${keyword}`, `${keyword} equivalence is bounded; general instance-set containment is not proven.`);
        resolved[keyword].forEach((item, index) => schema(item, `${location}.${keyword}[${index}]`, nextReferences, depth + 1));
      }
      for (const key of SCHEMA_MAPS) if (record(resolved[key])) {
        for (const [name, child] of Object.entries(resolved[key])) schema(child, `${location}.${key}[${JSON.stringify(name)}]`, nextReferences, depth + 1);
      }
      for (const key of SCHEMA_CHILDREN) if (resolved[key] !== undefined) {
        // In OAS 3.0 additionalProperties permits a boolean even though a
        // standalone Schema Object (including items) does not.
        if (key === 'additionalProperties' && typeof resolved[key] === 'boolean') continue;
        schema(resolved[key], `${location}.${key}`, nextReferences, depth + 1);
      }
    }
    function media(content: unknown, location: string, references: Set<string>, depth: number): void {
      if (!record(content)) return;
      for (const [name, value] of Object.entries(content)) {
        if (!record(value)) continue;
        const where = `${location}[${JSON.stringify(name)}]`;
        if (record(value.encoding) && Object.keys(value.encoding).length) warning('MEDIA_ENCODING_NOT_ANALYSED', `${where}.encoding`, 'Per-part and form encoding changes are not compared by this release.');
        schema(value.schema, `${where}.schema`, references, depth + 1);
      }
    }
    function parameter(value: unknown, location: string, references: Set<string>, depth: number): void {
      const node = generic(value, location, 'Parameter/header', new Set(references));
      if (!node) return;
      schema(node.schema, `${location}.schema`, references, depth + 1);
      media(node.content, `${location}.content`, references, depth + 1);
    }
    function operation(value: unknown, location: string, references: Set<string>, depth: number): void {
      if (!consume(location, depth)) return;
      const node = generic(value, location, 'Operation', new Set(references));
      if (!node) return;
      security(node.security);
      if (record(node.callbacks) && Object.keys(node.callbacks).length) warning('CALLBACKS_NOT_ANALYSED', `${location}.callbacks`, 'Callback operations and runtime-expression routing are outside this release.');
      if (Array.isArray(node.servers) && node.servers.length) warning('SERVERS_NOT_ANALYSED', `${location}.servers`, 'Operation server overrides are not compared.');
      if (Array.isArray(node.parameters)) node.parameters.forEach((item, index) => parameter(item, `${location}.parameters[${index}]`, references, depth + 1));
      const body = generic(node.requestBody, `${location}.requestBody`, 'Request body', new Set(references));
      if (body) media(body.content, `${location}.requestBody.content`, references, depth + 1);
      if (record(node.responses)) for (const [status, value] of Object.entries(node.responses)) {
        if (status.startsWith('x-')) continue;
        const where = `${location}.responses[${JSON.stringify(status)}]`;
        const response = generic(value, where, 'Response', new Set(references));
        if (!response) continue;
        if (record(response.links) && Object.keys(response.links).length) warning('RESPONSE_LINKS_NOT_ANALYSED', `${where}.links`, 'Response link and operation-chaining semantics are not analysed.');
        media(response.content, `${where}.content`, references, depth + 1);
        if (record(response.headers)) for (const [name, header] of Object.entries(response.headers)) if (name.toLowerCase() !== 'content-type') parameter(header, `${where}.headers[${JSON.stringify(name)}]`, references, depth + 1);
      }
    }
    function security(value: unknown): void {
      if (!Array.isArray(value) || !record(document.components) || !record(document.components.securitySchemes)) return;
      for (const requirement of value) if (record(requirement)) for (const name of Object.keys(requirement)) {
        const where = `components.securitySchemes[${JSON.stringify(name)}]`;
        generic(document.components.securitySchemes[name], where, 'Security scheme', new Set());
      }
    }
    security(document.security);
    if (record(document.paths)) for (const [path, value] of Object.entries(document.paths)) {
      if (!path.startsWith('/')) continue;
      const location = `paths[${JSON.stringify(path)}]`;
      const references = new Set<string>();
      const node = resolvePathItemNode(document, value);
      if (!record(node)) continue;
      const conflicts = pathItemReferenceConflicts(document, value);
      if (conflicts.length) {
        warning('PATH_ITEM_REFERENCE_CONFLICT', location, `Path Item reference and sibling fields overlap or cannot be resolved unambiguously (${conflicts.join(', ')}); operation comparison at this path is withheld.`);
        continue;
      }
      if (Array.isArray(node.servers) && node.servers.length) warning('SERVERS_NOT_ANALYSED', `${location}.servers`, 'Path-level server overrides are not compared.');
      if (Array.isArray(node.parameters)) node.parameters.forEach((item, index) => parameter(item, `${location}.parameters[${index}]`, references, 1));
      for (const method of METHODS) if (node[method] !== undefined) operation(node[method], `${location}.${method}`, references, 1);
    }
  }
  warnings.sort((a, b) => `${a.side}:${a.location}:${a.code}` < `${b.side}:${b.location}:${b.code}` ? -1 : 1);
  return { status: warnings.length || truncated ? 'partial' : 'complete', warnings, truncated };
}

function record(value: unknown): value is Node { return typeof value === 'object' && value !== null && !Array.isArray(value); }
