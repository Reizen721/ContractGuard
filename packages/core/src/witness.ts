import { prepareContract } from './bundle.js';
import { validateEvidenceValue } from './evidence-schema.js';
import { resolveNode } from './parser.js';
import {
  extractSchemaBaseType,
  inferSchemaMigrations,
  normalizeEffectiveSchema,
  type SchemaAlignmentReport,
  type SchemaMigrationHypothesis,
} from './schema-align.js';
import type { OpenApiDocument, OpenApiInput } from './types.js';

export type WitnessKind =
  | 'baseline-nominal'
  | 'candidate-nominal'
  | 'adversarial-null'
  | 'adversarial-optional-omitted'
  | 'adversarial-enum-variant'
  | 'adversarial-empty-array';

export interface ContractWitness {
  id: string;
  kind: WitnessKind;
  operation: { method: string; path: string };
  status: number;
  targetPath?: string;
  hypothesisId?: string;
  description: string;
  body: unknown;
  schemaValid: boolean;
}

export interface OperationWitnessSuite {
  operation: { method: string; path: string };
  baselineNominal: ContractWitness;
  candidateNominal: ContractWitness;
  adversarial: ContractWitness[];
}

export interface OutboundRequestCapture {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface OutboundRequestValidation {
  valid: boolean;
  matchedOperation?: { method: string; path: string };
  violations: Array<{ code: string; location: string; message: string }>;
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveOperationNode(
  document: OpenApiDocument,
  method: string,
  routeOrPath: string,
): { templatePath: string; pathItem: Record<string, unknown>; operation: Record<string, unknown> } | undefined {
  const cleanPath = routeOrPath.split(/[?#]/, 1)[0] ?? routeOrPath;
  const paths = document.paths ?? {};
  let matchedTemplate: string | undefined;
  if (Object.hasOwn(paths, cleanPath)) {
    matchedTemplate = cleanPath;
  } else {
    const segs = cleanPath.split('/');
    for (const template of Object.keys(paths)) {
      const tSegs = template.split('/');
      if (
        tSegs.length === segs.length &&
        tSegs.every((part, idx) => (/^\{[^{}]+\}$/.test(part) ? Boolean(segs[idx]) : part === segs[idx]))
      ) {
        matchedTemplate = template;
        break;
      }
    }
  }
  if (!matchedTemplate) return undefined;
  const pathItem = resolveNode(document, paths[matchedTemplate]);
  if (!isObj(pathItem)) return undefined;
  const operation = resolveNode(document, pathItem[method.toLowerCase()]);
  if (!isObj(operation)) return undefined;
  return { templatePath: matchedTemplate, pathItem, operation };
}

function getResponseSchemaAndStatus(
  document: OpenApiDocument,
  method: string,
  path: string,
  preferredStatus?: number,
): { status: number; schema: Record<string, unknown> } | undefined {
  const resolved = resolveOperationNode(document, method, path);
  if (!resolved || !isObj(resolved.operation.responses)) return undefined;
  const responses = resolved.operation.responses;
  const candidates = [
    ...(preferredStatus ? [String(preferredStatus)] : []),
    '200',
    '201',
    '202',
    ...Object.keys(responses),
  ];
  for (const code of new Set(candidates)) {
    if (!Object.hasOwn(responses, code)) continue;
    const resObj = resolveNode(document, responses[code]);
    if (!isObj(resObj) || !isObj(resObj.content)) continue;
    const jsonMedia = resObj.content['application/json'];
    if (!isObj(jsonMedia) || jsonMedia.schema === undefined) continue;
    const schema = normalizeEffectiveSchema(document, jsonMedia.schema);
    const numeric = Number.parseInt(code, 10);
    if (schema && Number.isFinite(numeric)) {
      return { status: numeric, schema };
    }
  }
  return undefined;
}

export function synthesizeSchemaValue(
  document: OpenApiDocument,
  rawSchema: unknown,
  fieldHint = 'value',
  depth = 0,
): unknown {
  if (depth > 10) return null;
  const schema = normalizeEffectiveSchema(document, rawSchema);
  if (!schema) return null;
  if (schema.example !== undefined) return structuredClone(schema.example);
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.const !== undefined) return structuredClone(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return structuredClone(schema.enum[0]);

  const { baseType } = extractSchemaBaseType(schema);
  if (baseType === 'string') {
    if (schema.format === 'date-time') return '2026-01-15T08:00:00.000Z';
    if (schema.format === 'date') return '2026-01-15';
    if (schema.format === 'email' || /email/i.test(fieldHint)) return 'alice@example.org';
    if (/decimal|amount|price/i.test(fieldHint)) return '15.00';
    if (/id|code|sku|ref/i.test(fieldHint)) return 'ORD-101';
    if (/name|label|handle|user/i.test(fieldHint)) return 'Alice';
    const minLen = typeof schema.minLength === 'number' ? schema.minLength : 0;
    const base = 'sample';
    return base.length >= minLen ? base : base.padEnd(minLen, 'x');
  }
  if (baseType === 'integer') {
    if (/cents/i.test(fieldHint)) return 1500;
    if (/at|epoch|timestamp/i.test(fieldHint)) return 1768464000;
    const min = typeof schema.minimum === 'number' ? Math.ceil(schema.minimum) : 1;
    const max = typeof schema.maximum === 'number' ? Math.floor(schema.maximum) : Math.max(min, 10);
    return Math.min(Math.max(min, 1), max);
  }
  if (baseType === 'number') {
    const min = typeof schema.minimum === 'number' ? schema.minimum : 1.5;
    const max = typeof schema.maximum === 'number' ? schema.maximum : Math.max(min, 15.0);
    return Math.min(Math.max(min, 1.5), max);
  }
  if (baseType === 'boolean') return true;
  if (baseType === 'array') {
    const count = typeof schema.minItems === 'number' ? Math.max(1, schema.minItems) : 1;
    return Array.from({ length: count }, () => synthesizeSchemaValue(document, schema.items, fieldHint, depth + 1));
  }
  if (baseType === 'object' || isObj(schema.properties)) {
    const out: Record<string, unknown> = {};
    const props = isObj(schema.properties) ? schema.properties : {};
    for (const [key, propSchema] of Object.entries(props)) {
      out[key] = synthesizeSchemaValue(document, propSchema, key, depth + 1);
    }
    return out;
  }
  return 'sample';
}

function getByDotPath(root: unknown, dotPath: string): unknown {
  if (!dotPath || dotPath === '[]') return root;
  const parts = dotPath.split('.');
  let cur: unknown = root;
  for (const rawPart of parts) {
    if (cur === null || cur === undefined) return undefined;
    const isArr = rawPart.endsWith('[]');
    const key = isArr ? rawPart.slice(0, -2) : rawPart;
    if (key) {
      if (!isObj(cur)) return undefined;
      cur = cur[key];
    }
    if (isArr) {
      if (!Array.isArray(cur) || cur.length === 0) return undefined;
      cur = cur[0];
    }
  }
  return cur;
}

function setByDotPath(root: unknown, dotPath: string, newVal: unknown, deleteLeaf = false): unknown {
  const clone = structuredClone(root);
  const parts = dotPath.split('.').filter(Boolean);
  if (parts.length === 0) return clone;

  function apply(target: unknown, idx: number): void {
    const rawPart = parts[idx]!;
    const isArr = rawPart.endsWith('[]');
    const key = isArr ? rawPart.slice(0, -2) : rawPart;
    const isLast = idx === parts.length - 1;

    if (key === '' && isArr) {
      if (Array.isArray(target)) {
        for (const item of target) {
          if (!isLast) apply(item, idx + 1);
        }
      }
      return;
    }

    if (!isObj(target)) return;
    if (isLast && !isArr) {
      if (deleteLeaf) delete target[key];
      else target[key] = structuredClone(newVal);
      return;
    }

    if (isArr) {
      const arr = target[key];
      if (Array.isArray(arr)) {
        if (isLast) {
          if (deleteLeaf) delete target[key];
          else target[key] = structuredClone(newVal);
        } else {
          for (const elem of arr) apply(elem, idx + 1);
        }
      }
      return;
    }

    if (!isObj(target[key])) target[key] = {};
    apply(target[key], idx + 1);
  }

  apply(clone, 0);
  return clone;
}

function coerceMigratedValue(
  rawVal: unknown,
  hyp: SchemaMigrationHypothesis,
  targetCandidateVal: unknown,
): unknown {
  if (rawVal === undefined) return targetCandidateVal;
  if (hyp.enumMapping && typeof rawVal === 'string' && hyp.enumMapping[rawVal]) {
    return hyp.enumMapping[rawVal];
  }
  switch (hyp.coercionHint) {
    case 'cents-to-decimal':
      return typeof rawVal === 'number' ? (rawVal / 100).toFixed(2) : String(rawVal);
    case 'epoch-to-iso':
      return typeof rawVal === 'number'
        ? new Date(rawVal > 1e12 ? rawVal : rawVal * 1000).toISOString()
        : String(rawVal);
    case 'number-to-string':
      return String(rawVal);
    case 'string-to-number': {
      const n = Number(rawVal);
      return Number.isFinite(n) ? n : targetCandidateVal;
    }
    case 'boolean-to-enum': {
      if (typeof rawVal === 'boolean') {
        const fromLower = (hyp.fromPath ?? '').toLowerCase();
        if (fromLower.includes('archiv') || fromLower.includes('disable') || fromLower.includes('close')) {
          return rawVal ? 'ARCHIVED' : 'ACTIVE';
        }
        return rawVal ? 'ACTIVE' : 'ARCHIVED';
      }
      return targetCandidateVal;
    }
    default:
      return rawVal;
  }
}

function copyMatchingUnchangedLeaves(baseBody: unknown, candTemplate: unknown): unknown {
  if (typeof baseBody === typeof candTemplate && baseBody !== null && typeof baseBody !== 'object') {
    return baseBody;
  }
  if (Array.isArray(baseBody) && Array.isArray(candTemplate)) {
    const elemTemplate = candTemplate[0] ?? {};
    return baseBody.map((item) => copyMatchingUnchangedLeaves(item, structuredClone(elemTemplate)));
  }
  if (isObj(baseBody) && isObj(candTemplate)) {
    const out = structuredClone(candTemplate);
    for (const [key, val] of Object.entries(out)) {
      if (Object.hasOwn(baseBody, key)) {
        const bVal = baseBody[key];
        if (typeof bVal === typeof val && bVal !== null && !Array.isArray(bVal) && typeof bVal !== 'object') {
          out[key] = bVal;
        } else if (Array.isArray(bVal) && Array.isArray(val)) {
          out[key] = copyMatchingUnchangedLeaves(bVal, val);
        } else if (isObj(bVal) && isObj(val)) {
          out[key] = copyMatchingUnchangedLeaves(bVal, val);
        }
      }
    }
    return out;
  }
  return candTemplate;
}

export function synthesizeDifferentialWitnesses(
  baselineInput: OpenApiInput,
  candidateInput: OpenApiInput,
  options: {
    alignment?: SchemaAlignmentReport;
    seedBaselineResponses?: Record<string, { status?: number; body: unknown }>;
  } = {},
): OperationWitnessSuite[] {
  const baselineDoc = prepareContract(baselineInput).document;
  const candidateDoc = prepareContract(candidateInput).document;
  const alignment = options.alignment ?? inferSchemaMigrations(baselineInput, candidateInput);
  const suites: OperationWitnessSuite[] = [];
  let seq = 1;
  const nextId = (prefix: string) => `${prefix}-${String(seq++).padStart(4, '0')}`;

  for (const opDiff of alignment.operations) {
    const opKey = `${opDiff.method} ${opDiff.path}`;
    const seed = options.seedBaselineResponses?.[opKey];
    const baseSpec = getResponseSchemaAndStatus(baselineDoc, opDiff.method, opDiff.path, seed?.status);
    const candSpec = getResponseSchemaAndStatus(candidateDoc, opDiff.method, opDiff.path, seed?.status);
    if (!baseSpec || !candSpec) continue;

    const baselineBody =
      seed?.body !== undefined
        ? structuredClone(seed.body)
        : synthesizeSchemaValue(baselineDoc, baseSpec.schema, opDiff.path);

    let candidateBody = synthesizeSchemaValue(candidateDoc, candSpec.schema, opDiff.path);
    candidateBody = copyMatchingUnchangedLeaves(baselineBody, candidateBody);

    const opHyps = alignment.hypotheses.filter(
      (h) =>
        h.direction === 'response' &&
        h.operation.method === opDiff.method &&
        h.operation.path === opDiff.path,
    );

    // Project semantic values across inferred response migrations
    for (const hyp of opHyps) {
      if (hyp.kind === 'envelope-wrap' && hyp.toPath && Array.isArray(baselineBody) && isObj(candidateBody)) {
        const itemTemplate = Array.isArray(candidateBody[hyp.toPath]) ? (candidateBody[hyp.toPath] as unknown[])[0] : {};
        const migratedItems = baselineBody.map((item) => copyMatchingUnchangedLeaves(item, structuredClone(itemTemplate)));
        candidateBody[hyp.toPath] = migratedItems;
        if (typeof candidateBody.total === 'number') candidateBody.total = migratedItems.length;
      } else if (
        (['field-rename', 'structural-nest', 'structural-flatten', 'type-coercion'].includes(hyp.kind) ||
          (hyp.kind === 'enum-extension' && hyp.enumMapping !== undefined)) &&
        hyp.fromPath &&
        hyp.toPath
      ) {
        if (hyp.fromPath.includes('[]') && hyp.toPath.includes('[]')) {
          const [baseArrPath, baseSub] = hyp.fromPath.split('[].');
          const [candArrPath, candSub] = hyp.toPath.split('[].');
          const baseArr = baseArrPath ? getByDotPath(baselineBody, baseArrPath) : baselineBody;
          const candArr = candArrPath ? getByDotPath(candidateBody, candArrPath) : candidateBody;
          if (Array.isArray(baseArr) && Array.isArray(candArr) && baseSub && candSub) {
            const updatedArr = candArr.map((cItem, idx) => {
              const bItem = baseArr[idx] ?? baseArr[0];
              const rawVal = getByDotPath(bItem, baseSub);
              const coerced = coerceMigratedValue(rawVal, hyp, getByDotPath(cItem, candSub));
              return setByDotPath(cItem, candSub, coerced);
            });
            candidateBody = candArrPath ? setByDotPath(candidateBody, candArrPath, updatedArr) : updatedArr;
          }
        } else {
          const rawVal = getByDotPath(baselineBody, hyp.fromPath);
          const targetDefault = getByDotPath(candidateBody, hyp.toPath);
          const coerced = coerceMigratedValue(rawVal, hyp, targetDefault);
          if (coerced !== undefined) {
            candidateBody = setByDotPath(candidateBody, hyp.toPath, coerced);
          }
        }
      }
    }

    const baseValid = validateEvidenceValue(baselineBody, baseSpec.schema, {
      document: baselineDoc,
      direction: 'response',
    }).status === 'valid';
    const candValid = validateEvidenceValue(candidateBody, candSpec.schema, {
      document: candidateDoc,
      direction: 'response',
    }).status === 'valid';

    const baselineNominal: ContractWitness = {
      id: nextId('WIT-BASE'),
      kind: 'baseline-nominal',
      operation: { method: opDiff.method, path: opDiff.path },
      status: baseSpec.status,
      description: `Baseline nominal response for ${opKey}`,
      body: baselineBody,
      schemaValid: baseValid,
    };

    const candidateNominal: ContractWitness = {
      id: nextId('WIT-CAND'),
      kind: 'candidate-nominal',
      operation: { method: opDiff.method, path: opDiff.path },
      status: candSpec.status,
      description: `Candidate nominal response preserving migrated values for ${opKey}`,
      body: candidateBody,
      schemaValid: candValid,
    };

    // Synthesize Differential Adversarial Witnesses (L(Candidate) \ L(Baseline))
    const adversarial: ContractWitness[] = [];

    for (const hyp of opHyps) {
      if (hyp.kind === 'nullability-widening' && hyp.toPath) {
        if (hyp.nullableNow) {
          const mutated = setByDotPath(candidateBody, hyp.toPath, null);
          const check = validateEvidenceValue(mutated, candSpec.schema, {
            document: candidateDoc,
            direction: 'response',
          });
          if (check.status === 'valid') {
            adversarial.push({
              id: nextId('WIT-NULL'),
              kind: 'adversarial-null',
              operation: { method: opDiff.method, path: opDiff.path },
              status: candSpec.status,
              targetPath: hyp.toPath,
              hypothesisId: hyp.id,
              description: `Adversarial boundary witness setting newly nullable '${hyp.toPath}' = null`,
              body: mutated,
              schemaValid: true,
            });
          }
        }
        if (hyp.optionalNow) {
          const mutated = setByDotPath(candidateBody, hyp.toPath, undefined, true);
          const check = validateEvidenceValue(mutated, candSpec.schema, {
            document: candidateDoc,
            direction: 'response',
          });
          if (check.status === 'valid') {
            adversarial.push({
              id: nextId('WIT-OPT'),
              kind: 'adversarial-optional-omitted',
              operation: { method: opDiff.method, path: opDiff.path },
              status: candSpec.status,
              targetPath: hyp.toPath,
              hypothesisId: hyp.id,
              description: `Adversarial boundary witness omitting newly optional property '${hyp.toPath}'`,
              body: mutated,
              schemaValid: true,
            });
          }
        }
      }

      if (hyp.kind === 'enum-extension' && hyp.toPath && hyp.addedEnumValues?.length) {
        for (const variant of hyp.addedEnumValues.slice(0, 2)) {
          const mutated = setByDotPath(candidateBody, hyp.toPath, variant);
          const check = validateEvidenceValue(mutated, candSpec.schema, {
            document: candidateDoc,
            direction: 'response',
          });
          if (check.status === 'valid') {
            adversarial.push({
              id: nextId('WIT-ENUM'),
              kind: 'adversarial-enum-variant',
              operation: { method: opDiff.method, path: opDiff.path },
              status: candSpec.status,
              targetPath: hyp.toPath,
              hypothesisId: hyp.id,
              description: `Adversarial boundary witness injecting new enum variant '${String(variant)}' at '${hyp.toPath}'`,
              body: mutated,
              schemaValid: true,
            });
          }
        }
      }
    }

    // Check newly emptyable arrays in candidate properties
    for (const candProp of opDiff.candidateProperties) {
      if (candProp.baseType === 'array' && (candProp.minItems === undefined || candProp.minItems === 0)) {
        const baseProp = opDiff.baselineProperties.find((p) => p.dotPath === candProp.dotPath);
        if (baseProp && baseProp.minItems !== undefined && baseProp.minItems > 0) {
          const mutated = setByDotPath(candidateBody, candProp.dotPath, []);
          const check = validateEvidenceValue(mutated, candSpec.schema, {
            document: candidateDoc,
            direction: 'response',
          });
          if (check.status === 'valid') {
            adversarial.push({
              id: nextId('WIT-EMPTY'),
              kind: 'adversarial-empty-array',
              operation: { method: opDiff.method, path: opDiff.path },
              status: candSpec.status,
              targetPath: candProp.dotPath,
              description: `Adversarial boundary witness setting relaxed array '${candProp.dotPath}' = []`,
              body: mutated,
              schemaValid: true,
            });
          }
        }
      }
    }

    suites.push({
      operation: { method: opDiff.method, path: opDiff.path },
      baselineNominal,
      candidateNominal,
      adversarial,
    });
  }

  return suites;
}

export function validateOutboundRequest(
  documentInput: OpenApiInput,
  request: OutboundRequestCapture,
): OutboundRequestValidation {
  const document = prepareContract(documentInput).document;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url, 'http://contractguard.local');
  } catch {
    return {
      valid: false,
      violations: [{ code: 'INVALID_REQUEST_URL', location: 'url', message: `Malformed request URL: ${request.url}` }],
    };
  }

  const resolved = resolveOperationNode(document, request.method, parsedUrl.pathname);
  if (!resolved) {
    return {
      valid: false,
      violations: [
        {
          code: 'OPERATION_NOT_FOUND',
          location: `${request.method.toUpperCase()} ${parsedUrl.pathname}`,
          message: `Outbound request ${request.method.toUpperCase()} ${parsedUrl.pathname} does not match any declared OpenAPI operation.`,
        },
      ],
    };
  }

  const violations: OutboundRequestValidation['violations'] = [];
  const rawParams = [
    ...(Array.isArray(resolved.pathItem.parameters) ? resolved.pathItem.parameters : []),
    ...(Array.isArray(resolved.operation.parameters) ? resolved.operation.parameters : []),
  ];
  const normHeaders = Object.fromEntries(
    Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );

  for (const rawP of rawParams) {
    const param = resolveNode(document, rawP);
    if (!isObj(param) || typeof param.name !== 'string' || typeof param.in !== 'string') continue;
    const schema = normalizeEffectiveSchema(document, param.schema) ?? {};
    const { baseType } = extractSchemaBaseType(schema);

    if (param.in === 'query') {
      const actual = parsedUrl.searchParams.get(param.name);
      if (actual === null || actual === '') {
        if (param.required === true) {
          violations.push({
            code: 'MISSING_REQUIRED_QUERY_PARAM',
            location: `query.${param.name}`,
            message: `Missing required query parameter '${param.name}'.`,
          });
        }
        continue;
      }
      if (Array.isArray(schema.enum) && !schema.enum.map(String).includes(actual)) {
        violations.push({
          code: 'INVALID_QUERY_ENUM',
          location: `query.${param.name}`,
          message: `Query parameter '${param.name}' value '${actual}' is not in enum [${schema.enum.join(', ')}].`,
        });
      }
      if (baseType === 'integer' || baseType === 'number') {
        const num = Number(actual);
        if (!Number.isFinite(num) || (baseType === 'integer' && !Number.isInteger(num))) {
          violations.push({
            code: 'INVALID_QUERY_TYPE',
            location: `query.${param.name}`,
            message: `Query parameter '${param.name}' expected ${baseType}, got '${actual}'.`,
          });
        } else {
          if (typeof schema.minimum === 'number' && num < schema.minimum) {
            violations.push({
              code: 'QUERY_BELOW_MINIMUM',
              location: `query.${param.name}`,
              message: `Query parameter '${param.name}' (${num}) < minimum ${schema.minimum}.`,
            });
          }
          if (typeof schema.maximum === 'number' && num > schema.maximum) {
            violations.push({
              code: 'QUERY_ABOVE_MAXIMUM',
              location: `query.${param.name}`,
              message: `Query parameter '${param.name}' (${num}) > maximum ${schema.maximum}.`,
            });
          }
        }
      }
    } else if (param.in === 'header') {
      const actual = normHeaders[param.name.toLowerCase()];
      if (!actual) {
        if (param.required === true) {
          violations.push({
            code: 'MISSING_REQUIRED_HEADER',
            location: `header.${param.name}`,
            message: `Missing required request header '${param.name}'.`,
          });
        }
      } else if (Array.isArray(schema.enum) && !schema.enum.map(String).includes(actual)) {
        violations.push({
          code: 'INVALID_HEADER_ENUM',
          location: `header.${param.name}`,
          message: `Header '${param.name}' value '${actual}' is not in enum [${schema.enum.join(', ')}].`,
        });
      }
    }
  }

  const reqBody = resolveNode(document, resolved.operation.requestBody);
  if (isObj(reqBody) && isObj(reqBody.content) && isObj(reqBody.content['application/json'])) {
    const bodySchema = normalizeEffectiveSchema(document, reqBody.content['application/json'].schema);
    if (reqBody.required === true && (request.body === undefined || request.body === null)) {
      violations.push({
        code: 'MISSING_REQUIRED_BODY',
        location: 'requestBody',
        message: 'Missing required JSON request body.',
      });
    } else if (request.body !== undefined && bodySchema) {
      const bodyValidation = validateEvidenceValue(request.body, bodySchema, {
        document,
        direction: 'request',
      });
      if (bodyValidation.status === 'invalid') {
        for (const issue of bodyValidation.issues) {
          violations.push({
            code: issue.code,
            location: `requestBody${issue.path}`,
            message: issue.message,
          });
        }
      }
    }
  }

  return {
    valid: violations.length === 0,
    matchedOperation: { method: request.method.toUpperCase(), path: resolved.templatePath },
    violations,
  };
}
