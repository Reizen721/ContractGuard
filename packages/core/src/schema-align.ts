import { prepareContract } from './bundle.js';
import { resolveNode } from './parser.js';
import type { OpenApiDocument, OpenApiInput } from './types.js';

export type MigrationHypothesisKind =
  | 'field-rename'
  | 'structural-nest'
  | 'structural-flatten'
  | 'envelope-wrap'
  | 'type-coercion'
  | 'nullability-widening'
  | 'enum-extension'
  | 'request-param-required'
  | 'request-param-rename'
  | 'request-body-rename';

export interface PropertyDescriptor {
  path: string[];
  dotPath: string;
  leaf: string;
  baseType: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'unknown';
  nullable: boolean;
  required: boolean;
  enumValues?: unknown[];
  format?: string;
  defaultValue?: unknown;
  exampleValue?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  description?: string;
}

export interface ParameterDescriptor {
  name: string;
  location: 'query' | 'header' | 'path';
  required: boolean;
  baseType: PropertyDescriptor['baseType'];
  enumValues?: unknown[];
  defaultValue?: unknown;
  minimum?: number;
  maximum?: number;
}

export interface SchemaMigrationHypothesis {
  id: string;
  kind: MigrationHypothesisKind;
  operation: { method: string; path: string };
  direction: 'request' | 'response';
  status?: string;
  fromPath?: string;
  toPath?: string;
  paramLocation?: 'query' | 'header';
  fromType?: PropertyDescriptor['baseType'];
  toType?: PropertyDescriptor['baseType'];
  coercionHint?: 'number-to-string' | 'string-to-number' | 'cents-to-decimal' | 'epoch-to-iso' | 'boolean-to-enum';
  enumMapping?: Record<string, string>;
  addedEnumValues?: unknown[];
  nullableNow?: boolean;
  optionalNow?: boolean;
  suggestedParamValue?: string;
  confidence: number;
  rationale: string;
}

export interface OperationSchemaDiff {
  method: string;
  path: string;
  responseStatus?: string;
  baselineResponseRootType?: PropertyDescriptor['baseType'];
  candidateResponseRootType?: PropertyDescriptor['baseType'];
  baselineProperties: PropertyDescriptor[];
  candidateProperties: PropertyDescriptor[];
  baselineParams: ParameterDescriptor[];
  candidateParams: ParameterDescriptor[];
  baselineRequestProps: PropertyDescriptor[];
  candidateRequestProps: PropertyDescriptor[];
}

export interface SchemaAlignmentReport {
  operations: OperationSchemaDiff[];
  hypotheses: SchemaMigrationHypothesis[];
  uncalledOrUnchangedOperations: Array<{ method: string; path: string }>;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeEffectiveSchema(
  document: OpenApiDocument,
  rawSchema: unknown,
  seen = new Set<object>(),
  depth = 0,
): Record<string, unknown> | undefined {
  if (depth > 24 || rawSchema === undefined || rawSchema === null) return undefined;
  const resolved = resolveNode(document, rawSchema);
  if (!isObj(resolved)) return undefined;
  if (seen.has(resolved)) return resolved;
  const nextSeen = new Set(seen);
  nextSeen.add(resolved);

  if (Array.isArray(resolved.allOf) && resolved.allOf.length > 0) {
    const merged: Record<string, unknown> = { ...resolved };
    delete merged.allOf;
    const props: Record<string, unknown> = isObj(merged.properties) ? { ...merged.properties } : {};
    const req = new Set<string>(Array.isArray(merged.required) ? merged.required.filter((x): x is string => typeof x === 'string') : []);
    for (const part of resolved.allOf) {
      const norm = normalizeEffectiveSchema(document, part, nextSeen, depth + 1);
      if (!norm) continue;
      if (!merged.type && norm.type) merged.type = norm.type;
      if (norm.nullable === true) merged.nullable = true;
      if (isObj(norm.properties)) Object.assign(props, norm.properties);
      if (Array.isArray(norm.required)) {
        for (const r of norm.required) if (typeof r === 'string') req.add(r);
      }
    }
    if (Object.keys(props).length > 0) {
      merged.type ??= 'object';
      merged.properties = props;
    }
    if (req.size > 0) merged.required = [...req];
    return merged;
  }
  return resolved;
}

export function extractSchemaBaseType(schema: Record<string, unknown>): {
  baseType: PropertyDescriptor['baseType'];
  nullable: boolean;
} {
  let nullable = schema.nullable === true;
  let baseType: PropertyDescriptor['baseType'] = 'unknown';
  if (typeof schema.type === 'string') {
    if (schema.type === 'null') nullable = true;
    else if (['string', 'number', 'integer', 'boolean', 'object', 'array'].includes(schema.type)) {
      baseType = schema.type as PropertyDescriptor['baseType'];
    }
  } else if (Array.isArray(schema.type)) {
    const types = schema.type.filter((item): item is string => typeof item === 'string');
    if (types.includes('null')) nullable = true;
    const nonNull = types.find((item) => item !== 'null');
    if (nonNull && ['string', 'number', 'integer', 'boolean', 'object', 'array'].includes(nonNull)) {
      baseType = nonNull as PropertyDescriptor['baseType'];
    }
  } else if (isObj(schema.properties)) {
    baseType = 'object';
  } else if (schema.items !== undefined) {
    baseType = 'array';
  } else if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const branches = (Array.isArray(schema.anyOf) ? schema.anyOf : schema.oneOf) as unknown[];
    for (const branch of branches) {
      if (isObj(branch) && branch.type === 'null') nullable = true;
      else if (isObj(branch) && typeof branch.type === 'string' && baseType === 'unknown') {
        if (['string', 'number', 'integer', 'boolean', 'object', 'array'].includes(branch.type)) {
          baseType = branch.type as PropertyDescriptor['baseType'];
        }
      }
    }
  }
  return { baseType, nullable };
}

export function collectSchemaProperties(
  document: OpenApiDocument,
  rawSchema: unknown,
  prefix: string[] = [],
  parentRequired = true,
  depth = 0,
): PropertyDescriptor[] {
  if (depth > 12) return [];
  const schema = normalizeEffectiveSchema(document, rawSchema);
  if (!schema) return [];
  const { baseType } = extractSchemaBaseType(schema);

  if (baseType === 'array' && schema.items !== undefined) {
    const itemPrefix = prefix.length === 0 ? ['[]'] : [...prefix.slice(0, -1), `${prefix.at(-1)!}[]`];
    return collectSchemaProperties(document, schema.items, itemPrefix, parentRequired, depth + 1);
  }

  if (!isObj(schema.properties)) return [];
  const requiredSet = new Set<string>(
    Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === 'string') : [],
  );
  const descriptors: PropertyDescriptor[] = [];

  for (const [key, propRaw] of Object.entries(schema.properties)) {
    const prop = normalizeEffectiveSchema(document, propRaw);
    if (!prop) continue;
    const { baseType: propType, nullable } = extractSchemaBaseType(prop);
    const isReq = parentRequired && requiredSet.has(key);
    const path = [...prefix, key];
    const dotPath = path.join('.').replace(/^\[\]\./, '[].');
    const enumValues = Array.isArray(prop.enum) ? [...prop.enum] : undefined;
    descriptors.push({
      path,
      dotPath,
      leaf: key,
      baseType: propType,
      nullable,
      required: isReq,
      ...(enumValues ? { enumValues } : {}),
      ...(typeof prop.format === 'string' ? { format: prop.format } : {}),
      ...(prop.default !== undefined ? { defaultValue: prop.default } : {}),
      ...(prop.example !== undefined ? { exampleValue: prop.example } : {}),
      ...(typeof prop.minimum === 'number' ? { minimum: prop.minimum } : {}),
      ...(typeof prop.maximum === 'number' ? { maximum: prop.maximum } : {}),
      ...(typeof prop.minItems === 'number' ? { minItems: prop.minItems } : {}),
      ...(typeof prop.description === 'string' ? { description: prop.description } : {}),
    });

    if (propType === 'object' || isObj(prop.properties)) {
      descriptors.push(...collectSchemaProperties(document, prop, path, isReq && !nullable, depth + 1));
    } else if (propType === 'array' && prop.items !== undefined) {
      descriptors.push(
        ...collectSchemaProperties(document, prop.items, [...prefix, `${key}[]`], isReq && !nullable, depth + 1),
      );
    }
  }
  return descriptors;
}

function tokenizeIdentifier(name: string): string[] {
  return name
    .replace(/\[\]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

const SEMANTIC_SYNONYMS: ReadonlyArray<readonly string[]> = [
  ['customer', 'buyer', 'client', 'user', 'owner', 'maintainer', 'account'],
  ['name', 'label', 'title', 'display', 'handle', 'username'],
  ['id', 'identifier', 'code', 'key', 'sku', 'ref', 'reference'],
  ['email', 'mail', 'contact'],
  ['phone', 'mobile', 'tel', 'telephone'],
  ['zip', 'postal', 'postcode'],
  ['amount', 'price', 'total', 'cost', 'cents', 'fee', 'decimal'],
  ['limit', 'size', 'count', 'max', 'page'],
  ['state', 'status', 'stage', 'phase'],
  ['created', 'timestamp', 'date', 'time', 'issued'],
];

function tokenSimilarity(leftName: string, rightName: string): number {
  const left = tokenizeIdentifier(leftName);
  const right = tokenizeIdentifier(rightName);
  if (!left.length || !right.length) return 0;
  if (left.join('_') === right.join('_')) return 1;

  let matches = 0;
  for (const l of left) {
    if (right.includes(l)) {
      matches += 1;
      continue;
    }
    const synGroup = SEMANTIC_SYNONYMS.find((group) => group.includes(l));
    if (synGroup && right.some((r) => synGroup.includes(r))) {
      matches += 0.72;
    }
  }
  return Math.min(1, (2 * matches) / (left.length + right.length));
}

function compatibleTypes(a: PropertyDescriptor['baseType'], b: PropertyDescriptor['baseType']): boolean {
  if (a === b) return true;
  if ((a === 'integer' && b === 'number') || (a === 'number' && b === 'integer')) return true;
  return false;
}

function detectCoercionHint(
  fromProp: PropertyDescriptor,
  toProp: PropertyDescriptor,
): SchemaMigrationHypothesis['coercionHint'] | undefined {
  const fromNumeric = fromProp.baseType === 'integer' || fromProp.baseType === 'number';
  const toNumeric = toProp.baseType === 'integer' || toProp.baseType === 'number';
  const fromTokens = tokenizeIdentifier(fromProp.dotPath);
  const toTokens = tokenizeIdentifier(toProp.dotPath);

  if (fromProp.baseType === 'integer' && toProp.baseType === 'string') {
    if (fromTokens.includes('cents') || toTokens.includes('decimal') || toProp.format === 'decimal') {
      return 'cents-to-decimal';
    }
    if (
      toProp.format === 'date-time' ||
      fromTokens.some((t) => ['at', 'time', 'timestamp', 'epoch', 'created'].includes(t)) &&
        (toProp.format === 'date-time' || toTokens.includes('iso'))
    ) {
      return 'epoch-to-iso';
    }
    return 'number-to-string';
  }
  if (fromNumeric && toProp.baseType === 'string') return 'number-to-string';
  if (fromProp.baseType === 'string' && toNumeric) return 'string-to-number';
  if (fromProp.baseType === 'boolean' && toProp.baseType === 'string') return 'boolean-to-enum';
  return undefined;
}

function extractOperationParams(document: OpenApiDocument, pathObj: Record<string, unknown>, opObj: Record<string, unknown>): ParameterDescriptor[] {
  const rawList = [
    ...(Array.isArray(pathObj.parameters) ? pathObj.parameters : []),
    ...(Array.isArray(opObj.parameters) ? opObj.parameters : []),
  ];
  const byKey = new Map<string, ParameterDescriptor>();
  for (const rawParam of rawList) {
    const param = resolveNode(document, rawParam);
    if (!isObj(param) || typeof param.name !== 'string' || typeof param.in !== 'string') continue;
    if (!['query', 'header', 'path'].includes(param.in)) continue;
    const schema = normalizeEffectiveSchema(document, param.schema) ?? {};
    const { baseType } = extractSchemaBaseType(schema);
    byKey.set(`${param.in}:${param.name}`, {
      name: param.name,
      location: param.in as ParameterDescriptor['location'],
      required: param.required === true || param.in === 'path',
      baseType,
      ...(Array.isArray(schema.enum) ? { enumValues: [...schema.enum] } : {}),
      ...(schema.default !== undefined ? { defaultValue: schema.default } : {}),
      ...(typeof schema.minimum === 'number' ? { minimum: schema.minimum } : {}),
      ...(typeof schema.maximum === 'number' ? { maximum: schema.maximum } : {}),
    });
  }
  return [...byKey.values()];
}

function primaryJsonResponse(
  document: OpenApiDocument,
  opObj: Record<string, unknown>,
): { status: string; schema: Record<string, unknown> } | undefined {
  if (!isObj(opObj.responses)) return undefined;
  const preferred = ['200', '201', '202', ...Object.keys(opObj.responses)];
  for (const status of new Set(preferred)) {
    if (!Object.hasOwn(opObj.responses, status)) continue;
    const res = resolveNode(document, opObj.responses[status]);
    if (!isObj(res) || !isObj(res.content)) continue;
    const media = res.content['application/json'];
    if (!isObj(media) || media.schema === undefined) continue;
    const schema = normalizeEffectiveSchema(document, media.schema);
    if (schema) return { status, schema };
  }
  return undefined;
}

function primaryJsonRequest(document: OpenApiDocument, opObj: Record<string, unknown>): Record<string, unknown> | undefined {
  const reqBody = resolveNode(document, opObj.requestBody);
  if (!isObj(reqBody) || !isObj(reqBody.content)) return undefined;
  const media = reqBody.content['application/json'];
  if (!isObj(media) || media.schema === undefined) return undefined;
  return normalizeEffectiveSchema(document, media.schema);
}

function synthesizeParamValue(param: ParameterDescriptor): string {
  if (param.defaultValue !== undefined && param.defaultValue !== null) return String(param.defaultValue);
  if (param.enumValues && param.enumValues.length > 0) return String(param.enumValues[0]);
  if (param.baseType === 'integer' || param.baseType === 'number') {
    if (param.minimum !== undefined) return String(param.minimum);
    if (param.maximum !== undefined) return String(Math.min(20, param.maximum));
    return '1';
  }
  if (param.baseType === 'boolean') return 'true';
  return 'v2';
}

export function inferSchemaMigrations(
  baselineInput: OpenApiInput,
  candidateInput: OpenApiInput,
): SchemaAlignmentReport {
  const baselineDoc = prepareContract(baselineInput).document;
  const candidateDoc = prepareContract(candidateInput).document;
  const operations: OperationSchemaDiff[] = [];
  const hypotheses: SchemaMigrationHypothesis[] = [];
  const uncalledOrUnchangedOperations: Array<{ method: string; path: string }> = [];
  let seq = 1;
  const nextId = () => `HYP-${String(seq++).padStart(4, '0')}`;

  const allPaths = new Set([
    ...Object.keys(baselineDoc.paths ?? {}),
    ...Object.keys(candidateDoc.paths ?? {}),
  ]);

  for (const route of [...allPaths].sort()) {
    const basePathObj = resolveNode(baselineDoc, baselineDoc.paths?.[route]);
    const candPathObj = resolveNode(candidateDoc, candidateDoc.paths?.[route]);
    if (!isObj(basePathObj) || !isObj(candPathObj)) continue;

    for (const methodKey of HTTP_METHODS) {
      const baseOp = resolveNode(baselineDoc, basePathObj[methodKey]);
      const candOp = resolveNode(candidateDoc, candPathObj[methodKey]);
      if (!isObj(baseOp) || !isObj(candOp)) continue;
      const method = methodKey.toUpperCase();
      const opRef = { method, path: route };

      const baseRes = primaryJsonResponse(baselineDoc, baseOp);
      const candRes = primaryJsonResponse(candidateDoc, candOp);
      const baseRootType = baseRes ? extractSchemaBaseType(baseRes.schema).baseType : undefined;
      const candRootType = candRes ? extractSchemaBaseType(candRes.schema).baseType : undefined;
      const baseProps = baseRes ? collectSchemaProperties(baselineDoc, baseRes.schema) : [];
      const candProps = candRes ? collectSchemaProperties(candidateDoc, candRes.schema) : [];
      const baseParams = extractOperationParams(baselineDoc, basePathObj, baseOp);
      const candParams = extractOperationParams(candidateDoc, candPathObj, candOp);
      const baseReqSchema = primaryJsonRequest(baselineDoc, baseOp);
      const candReqSchema = primaryJsonRequest(candidateDoc, candOp);
      const baseReqProps = baseReqSchema ? collectSchemaProperties(baselineDoc, baseReqSchema) : [];
      const candReqProps = candReqSchema ? collectSchemaProperties(candidateDoc, candReqSchema) : [];

      operations.push({
        method,
        path: route,
        ...(candRes?.status ? { responseStatus: candRes.status } : baseRes?.status ? { responseStatus: baseRes.status } : {}),
        ...(baseRootType ? { baselineResponseRootType: baseRootType } : {}),
        ...(candRootType ? { candidateResponseRootType: candRootType } : {}),
        baselineProperties: baseProps,
        candidateProperties: candProps,
        baselineParams: baseParams,
        candidateParams: candParams,
        baselineRequestProps: baseReqProps,
        candidateRequestProps: candReqProps,
      });

      const beforeHypCount = hypotheses.length;

      // 1. Check Root Array -> Envelope Object Wrap (e.g., Order[] -> { data: Order[], total: number })
      if (baseRootType === 'array' && candRootType === 'object') {
        const arrayHolder = candProps.find((p) => p.path.length === 1 && p.baseType === 'array');
        if (arrayHolder) {
          hypotheses.push({
            id: nextId(),
            kind: 'envelope-wrap',
            operation: opRef,
            direction: 'response',
            ...(candRes?.status ? { status: candRes.status } : {}),
            fromPath: '[]',
            toPath: arrayHolder.dotPath,
            fromType: 'array',
            toType: 'array',
            confidence: 0.94,
            rationale: `Response root array wrapped into envelope property '${arrayHolder.dotPath}'.`,
          });
        }
      }

      // 2. Compare Same-Path Response Properties (Type Coercion, Nullability Widening, Enum Extension)
      const candByPath = new Map(candProps.map((p) => [p.dotPath, p]));
      const baseByPath = new Map(baseProps.map((p) => [p.dotPath, p]));

      for (const baseProp of baseProps) {
        const sameCand = candByPath.get(baseProp.dotPath);
        if (!sameCand) continue;

        const hint = detectCoercionHint(baseProp, sameCand);
        if (hint) {
          hypotheses.push({
            id: nextId(),
            kind: 'type-coercion',
            operation: opRef,
            direction: 'response',
            ...(candRes?.status ? { status: candRes.status } : {}),
            fromPath: baseProp.dotPath,
            toPath: sameCand.dotPath,
            fromType: baseProp.baseType,
            toType: sameCand.baseType,
            coercionHint: hint,
            confidence: 0.95,
            rationale: `Property '${baseProp.dotPath}' changed type from ${baseProp.baseType} to ${sameCand.baseType} (${hint}).`,
          });
        }

        if ((!baseProp.nullable && sameCand.nullable) || (baseProp.required && !sameCand.required)) {
          hypotheses.push({
            id: nextId(),
            kind: 'nullability-widening',
            operation: opRef,
            direction: 'response',
            ...(candRes?.status ? { status: candRes.status } : {}),
            fromPath: baseProp.dotPath,
            toPath: sameCand.dotPath,
            fromType: baseProp.baseType,
            toType: sameCand.baseType,
            nullableNow: sameCand.nullable,
            optionalNow: !sameCand.required,
            confidence: 0.98,
            rationale: `Response property '${sameCand.dotPath}' became ${sameCand.nullable ? 'nullable' : 'optional'}.`,
          });
        }

        if (baseProp.enumValues && sameCand.enumValues) {
          const baseSet = new Set(baseProp.enumValues.map((v) => JSON.stringify(v)));
          const candSet = new Set(sameCand.enumValues.map((v) => JSON.stringify(v)));
          const added = sameCand.enumValues.filter((v) => !baseSet.has(JSON.stringify(v)));
          const removed = baseProp.enumValues.filter((v) => !candSet.has(JSON.stringify(v)));
          const enumMapping: Record<string, string> = {};
          if (removed.length > 0 && added.length >= removed.length) {
            for (let idx = 0; idx < removed.length; idx++) {
              enumMapping[String(removed[idx])] = String(added[idx]);
            }
          }
          if (added.length > 0) {
            hypotheses.push({
              id: nextId(),
              kind: 'enum-extension',
              operation: opRef,
              direction: 'response',
              ...(candRes?.status ? { status: candRes.status } : {}),
              fromPath: baseProp.dotPath,
              toPath: sameCand.dotPath,
              addedEnumValues: added,
              ...(Object.keys(enumMapping).length > 0 ? { enumMapping } : {}),
              confidence: 0.96,
              rationale: `Response enum '${sameCand.dotPath}' introduced new domain variants: ${added.map(String).join(', ')}.`,
            });
          }
        }
      }

      // 3. Align Removed Leaf Properties -> Added Leaf Properties (Rename, Nest, Flatten, Rename+TypeShift, Rename+Nullability)
      const removedLeaves = baseProps.filter(
        (p) => p.baseType !== 'object' && !candByPath.has(p.dotPath),
      );
      const addedLeaves = candProps.filter(
        (p) => p.baseType !== 'object' && !baseByPath.has(p.dotPath),
      );

      // Ignore envelope lift if already covered by envelope-wrap
      const envelopePrefix = hypotheses.find(
        (h) => h.kind === 'envelope-wrap' && h.operation.method === method && h.operation.path === route,
      )?.toPath;

      const usedAdded = new Set<string>();
      const candidatePairs: Array<{
        from: PropertyDescriptor;
        to: PropertyDescriptor;
        score: number;
      }> = [];

      for (const rem of removedLeaves) {
        if (envelopePrefix && candByPath.has(rem.dotPath.replace(/^\[\]\./, `${envelopePrefix}[].`))) {
          continue;
        }
        for (const add of addedLeaves) {
          const sameParent =
            rem.path.slice(0, -1).join('.') === add.path.slice(0, -1).join('.');
          const typeCompat = compatibleTypes(rem.baseType, add.baseType);
          const coercion = detectCoercionHint(rem, add);
          if (!typeCompat && !coercion) continue;

          const leafSim = tokenSimilarity(rem.leaf, add.leaf);
          const fullSim = tokenSimilarity(rem.dotPath, add.dotPath);
          let score = Math.max(leafSim * 0.65 + fullSim * 0.35, fullSim);
          if (sameParent) score += 0.15;
          if (typeCompat) score += 0.12;
          if (removedLeaves.length === 1 && addedLeaves.length === 1) score = Math.max(score, 0.84);
          if (score >= 0.42) {
            candidatePairs.push({ from: rem, to: add, score: Math.min(0.99, Number(score.toFixed(2))) });
          }
        }
      }

      candidatePairs.sort((a, b) => b.score - a.score);
      const usedRemoved = new Set<string>();

      for (const pair of candidatePairs) {
        if (usedRemoved.has(pair.from.dotPath) || usedAdded.has(pair.to.dotPath)) continue;
        usedRemoved.add(pair.from.dotPath);
        usedAdded.add(pair.to.dotPath);

        const sameParent = pair.from.path.slice(0, -1).join('.') === pair.to.path.slice(0, -1).join('.');
        const kind: MigrationHypothesisKind = sameParent
          ? 'field-rename'
          : pair.to.path.length > pair.from.path.length
            ? 'structural-nest'
            : 'structural-flatten';

        const coercionHint = detectCoercionHint(pair.from, pair.to);
        hypotheses.push({
          id: nextId(),
          kind,
          operation: opRef,
          direction: 'response',
          ...(candRes?.status ? { status: candRes.status } : {}),
          fromPath: pair.from.dotPath,
          toPath: pair.to.dotPath,
          fromType: pair.from.baseType,
          toType: pair.to.baseType,
          ...(coercionHint ? { coercionHint } : {}),
          nullableNow: pair.to.nullable,
          optionalNow: !pair.to.required,
          confidence: pair.score,
          rationale: `Aligned removed field '${pair.from.dotPath}' (${pair.from.baseType}) -> '${pair.to.dotPath}' (${pair.to.baseType}).`,
        });

        // If the renamed/nested target OR any newly introduced ancestor object is nullable/optional, emit explicit nullability hazard!
        const emittedNullabilityPaths = new Set(
          hypotheses.filter((h) => h.kind === 'nullability-widening').map((h) => h.toPath),
        );
        for (let prefixLen = 1; prefixLen < pair.to.path.length; prefixLen++) {
          const ancPath = pair.to.path.slice(0, prefixLen).join('.');
          const candAnc = candByPath.get(ancPath);
          const baseAnc = baseByPath.get(ancPath);
          if (
            candAnc &&
            !emittedNullabilityPaths.has(ancPath) &&
            ((!(baseAnc?.nullable ?? false) && candAnc.nullable) ||
              ((baseAnc?.required ?? true) && !candAnc.required))
          ) {
            emittedNullabilityPaths.add(ancPath);
            hypotheses.push({
              id: nextId(),
              kind: 'nullability-widening',
              operation: opRef,
              direction: 'response',
              ...(candRes?.status ? { status: candRes.status } : {}),
              fromPath: pair.from.dotPath,
              toPath: ancPath,
              fromType: pair.from.baseType,
              toType: candAnc.baseType,
              nullableNow: candAnc.nullable,
              optionalNow: !candAnc.required,
              confidence: 0.97,
              rationale: `Ancestor container '${ancPath}' of migrated property '${pair.to.dotPath}' is ${candAnc.nullable ? 'nullable' : 'optional'}.`,
            });
          }
        }

        if (
          !emittedNullabilityPaths.has(pair.to.dotPath) &&
          ((!pair.from.nullable && pair.to.nullable) || (pair.from.required && !pair.to.required))
        ) {
          hypotheses.push({
            id: nextId(),
            kind: 'nullability-widening',
            operation: opRef,
            direction: 'response',
            ...(candRes?.status ? { status: candRes.status } : {}),
            fromPath: pair.from.dotPath,
            toPath: pair.to.dotPath,
            fromType: pair.from.baseType,
            toType: pair.to.baseType,
            nullableNow: pair.to.nullable,
            optionalNow: !pair.to.required,
            confidence: 0.96,
            rationale: `Migrated target '${pair.to.dotPath}' also widened nullability/optionality relative to '${pair.from.dotPath}'.`,
          });
        }
      }

      // 4. Request Parameters: Newly Required or Renamed Query/Header Parameters
      const baseParamMap = new Map(baseParams.map((p) => [`${p.location}:${p.name}`, p]));
      const candParamMap = new Map(candParams.map((p) => [`${p.location}:${p.name}`, p]));
      const removedParams = baseParams.filter((p) => !candParamMap.has(`${p.location}:${p.name}`));
      const addedParams = candParams.filter((p) => !baseParamMap.has(`${p.location}:${p.name}`));

      const pairedAddedParams = new Set<string>();
      for (const remP of removedParams) {
        const bestAdd = addedParams.find(
          (addP) =>
            addP.location === remP.location &&
            !pairedAddedParams.has(`${addP.location}:${addP.name}`) &&
            (compatibleTypes(remP.baseType, addP.baseType) || tokenSimilarity(remP.name, addP.name) >= 0.35),
        );
        if (bestAdd && (remP.location === 'query' || remP.location === 'header')) {
          pairedAddedParams.add(`${bestAdd.location}:${bestAdd.name}`);
          hypotheses.push({
            id: nextId(),
            kind: 'request-param-rename',
            operation: opRef,
            direction: 'request',
            fromPath: remP.name,
            toPath: bestAdd.name,
            paramLocation: remP.location,
            fromType: remP.baseType,
            toType: bestAdd.baseType,
            ...(bestAdd.maximum !== undefined ? { suggestedParamValue: String(bestAdd.maximum) } : {}),
            confidence: 0.88,
            rationale: `Request ${remP.location} parameter '${remP.name}' renamed to '${bestAdd.name}'.`,
          });
        }
      }

      for (const candP of candParams) {
        if (candP.location !== 'query' && candP.location !== 'header') continue;
        if (pairedAddedParams.has(`${candP.location}:${candP.name}`)) continue;
        const prev = baseParamMap.get(`${candP.location}:${candP.name}`);
        if (candP.required && (!prev || !prev.required)) {
          hypotheses.push({
            id: nextId(),
            kind: 'request-param-required',
            operation: opRef,
            direction: 'request',
            toPath: candP.name,
            paramLocation: candP.location,
            toType: candP.baseType,
            suggestedParamValue: synthesizeParamValue(candP),
            confidence: 0.97,
            rationale: `Request ${candP.location} parameter '${candP.name}' is now required.`,
          });
        }
      }

      // 5. Request Body Property Renames
      const baseReqMap = new Map(baseReqProps.map((p) => [p.dotPath, p]));
      const candReqMap = new Map(candReqProps.map((p) => [p.dotPath, p]));
      const remReq = baseReqProps.filter((p) => p.baseType !== 'object' && !candReqMap.has(p.dotPath));
      const addReq = candReqProps.filter((p) => p.baseType !== 'object' && !baseReqMap.has(p.dotPath));
      if (remReq.length > 0 && addReq.length > 0) {
        const usedReqAdd = new Set<string>();
        for (const r of remReq) {
          const match = addReq.find(
            (a) =>
              !usedReqAdd.has(a.dotPath) &&
              compatibleTypes(r.baseType, a.baseType) &&
              (remReq.length === 1 && addReq.length === 1 || tokenSimilarity(r.leaf, a.leaf) >= 0.4),
          );
          if (match) {
            usedReqAdd.add(match.dotPath);
            hypotheses.push({
              id: nextId(),
              kind: 'request-body-rename',
              operation: opRef,
              direction: 'request',
              fromPath: r.dotPath,
              toPath: match.dotPath,
              fromType: r.baseType,
              toType: match.baseType,
              confidence: 0.89,
              rationale: `Request JSON body property '${r.dotPath}' renamed to '${match.dotPath}'.`,
            });
          }
        }
      }

      if (hypotheses.length === beforeHypCount) {
        uncalledOrUnchangedOperations.push(opRef);
      }
    }
  }

  return { operations, hypotheses, uncalledOrUnchangedOperations };
}
