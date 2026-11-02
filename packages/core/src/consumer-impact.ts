import { prepareContract } from './bundle.js';
import { ContractGuardError } from './errors.js';
import { validateEvidenceValue } from './evidence-schema.js';
import { fingerprintObject } from './fingerprint.js';
import { pathItemReferenceConflicts, resolveNode, resolvePathItemNode } from './parser.js';
import type { AnalysisResult, Change, OpenApiDocument, OpenApiInput } from './types.js';
import type { ConsumerCheck, ConsumerCheckStatus, ConsumerEvidence, ConsumerImpactReport, ConsumerInteraction, ConsumerRequestExample, ConsumerResponseExample, EvidenceValidation } from './evidence-types.js';

type Node = Record<string, unknown>;
const METHODS = new Set(['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE']);
const LOCATIONS = ['path', 'query', 'header', 'cookie'] as const;
const MAX_ISSUES = 40;
interface WorkBudget { schemaEvaluations: number; parameterDefinitions: number }
export const CONSUMER_EVIDENCE_LIMITS = Object.freeze({ bytes: 1024 * 1024, consumers: 50, interactions: 200, values: 30_000, depth: 64 });
const own = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value);
const pointer = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');

function fail(message: string): never { throw new ContractGuardError('INVALID_CONSUMER_EVIDENCE', message); }

/** Validate before cloning/hashing; values are JSON only and never evaluated as code. */
function validateJson(value: unknown): void {
  let count = 0;
  const ancestors = new WeakSet<object>();
  function visit(item: unknown, depth: number): void {
    if (++count > CONSUMER_EVIDENCE_LIMITS.values || depth > CONSUMER_EVIDENCE_LIMITS.depth) fail('Consumer evidence exceeds its JSON value/depth budget.');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === null) fail('Consumer evidence must contain only finite JSON values.');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) fail('Consumer evidence must contain only plain JSON objects.');
    if (ancestors.has(item)) fail('Consumer evidence must not contain circular references.');
    if (Object.getOwnPropertySymbols(item).length) fail('Consumer evidence must not contain symbol properties.');
    if (Object.values(Object.getOwnPropertyDescriptors(item)).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)) fail('Consumer evidence must not contain accessor properties.');
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (Object.keys(item).some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)) fail('Consumer evidence arrays must not contain named properties.');
      for (let index = 0; index < item.length; index += 1) {
        if (!own(item, index)) fail('Consumer evidence must not contain sparse arrays.');
        visit(item[index], depth + 1);
      }
    } else {
      for (const child of Object.values(item)) visit(child, depth + 1);
    }
    ancestors.delete(item);
  }
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > CONSUMER_EVIDENCE_LIMITS.bytes) fail('Consumer evidence exceeds the 1048576-byte limit.');
}

function object(value: unknown, location: string, fields: string[]): Node {
  if (!record(value)) fail(`${location} must be an object.`);
  if (Object.keys(value).some((key) => !fields.includes(key))) fail(`${location} contains an unsupported field.`);
  return value;
}

function text(value: unknown, location: string, max = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(`${location} must be a nonempty string of at most ${max} characters without control characters.`);
  return value;
}

function identifier(value: unknown, location: string): string {
  const result = text(value, location, 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) fail(`${location} must use letters, digits, dot, underscore, or hyphen and start with a letter or digit.`);
  return result;
}

function mediaType(value: unknown, location: string): string {
  const result = text(value, location, 160);
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(result)) fail(`${location} must be a concrete media type without parameters, such as application/json.`);
  return result.toLowerCase();
}

/** Closed manifest shape catches typos, while payload and expectation objects remain JSON data. */
export function validateConsumerEvidence(input: unknown): ConsumerEvidence {
  validateJson(input);
  const root = object(input, 'Consumer evidence', ['schemaVersion', 'consumers']);
  if (root.schemaVersion !== 1) fail('Consumer evidence schemaVersion must be 1.');
  if (!Array.isArray(root.consumers) || root.consumers.length < 1 || root.consumers.length > CONSUMER_EVIDENCE_LIMITS.consumers) fail('Consumer evidence must contain 1 to 50 consumers.');
  const consumerIds = new Set<string>();
  let interactionCount = 0;
  const consumers = root.consumers.map((inputConsumer, consumerIndex) => {
    const where = `consumers[${consumerIndex}]`;
    const consumer = object(inputConsumer, where, ['id', 'name', 'owner', 'criticality', 'interactions']);
    const id = identifier(consumer.id, `${where}.id`);
    if (consumerIds.has(id)) fail('Consumer ids must be unique.');
    consumerIds.add(id);
    const name = text(consumer.name, `${where}.name`);
    const owner = own(consumer, 'owner') ? text(consumer.owner, `${where}.owner`) : undefined;
    if (consumer.criticality !== 'critical' && consumer.criticality !== 'standard') fail(`${where}.criticality must be critical or standard.`);
    if (!Array.isArray(consumer.interactions) || consumer.interactions.length === 0) fail(`${where}.interactions must be a nonempty array.`);
    const interactionIds = new Set<string>();
    const interactions = consumer.interactions.map((inputInteraction, interactionIndex): ConsumerInteraction => {
      if (++interactionCount > CONSUMER_EVIDENCE_LIMITS.interactions) fail('Consumer evidence must contain at most 200 interactions in total.');
      const at = `${where}.interactions[${interactionIndex}]`;
      const interaction = object(inputInteraction, at, ['id', 'name', 'method', 'path', 'request', 'response']);
      const interactionId = identifier(interaction.id, `${at}.id`);
      if (interactionIds.has(interactionId)) fail(`${where} contains duplicate interaction ids.`);
      interactionIds.add(interactionId);
      const method = text(interaction.method, `${at}.method`, 10).toUpperCase();
      if (!METHODS.has(method)) fail(`${at}.method must be an OpenAPI HTTP method.`);
      const path = text(interaction.path, `${at}.path`, 512);
      if (!path.startsWith('/') || path.includes('?') || path.includes('#')) fail(`${at}.path must be an exact OpenAPI path template without query strings or fragments.`);
      if (!own(interaction, 'request') && !own(interaction, 'response')) fail(`${at} requires a request or response example.`);
      const result: ConsumerInteraction = { id: interactionId, method, path, ...(own(interaction, 'name') ? { name: text(interaction.name, `${at}.name`) } : {}) };
      if (own(interaction, 'request')) {
        const request = object(interaction.request, `${at}.request`, ['parameters', 'mediaType', 'body']);
        if (own(request, 'parameters')) {
          const parameters = object(request.parameters, `${at}.request.parameters`, [...LOCATIONS]);
          for (const location of LOCATIONS) if (own(parameters, location)) {
            if (!record(parameters[location])) fail(`${at}.request.parameters.${location} must be an object of decoded values.`);
            const seen = new Set<string>();
            for (const key of Object.keys(parameters[location])) {
              text(key, `${at}.request parameter name`, 200);
              const identity = location === 'header' ? key.toLowerCase() : key;
              if (seen.has(identity)) fail(`${at}.request contains case-colliding headers.`);
              seen.add(identity);
            }
          }
        }
        if (own(request, 'body') && !own(request, 'mediaType')) fail(`${at}.request.mediaType is required when body is supplied.`);
        result.request = { ...(request as ConsumerRequestExample), ...(own(request, 'mediaType') ? { mediaType: mediaType(request.mediaType, `${at}.request.mediaType`) } : {}) };
      }
      if (own(interaction, 'response')) {
        const response = object(interaction.response, `${at}.response`, ['status', 'mediaType', 'baselineBody', 'candidateBody', 'expectation']);
        const status = text(response.status, `${at}.response.status`, 3);
        if (!/^[1-5]\d{2}$/.test(status)) fail(`${at}.response.status must be a concrete three-digit HTTP status.`);
        if (!own(response, 'baselineBody')) fail(`${at}.response.baselineBody is required, including null for a JSON null body.`);
        if (typeof response.expectation !== 'boolean' && !record(response.expectation)) fail(`${at}.response.expectation must be a JSON Schema object or boolean.`);
        result.response = { status, mediaType: mediaType(response.mediaType, `${at}.response.mediaType`), baselineBody: response.baselineBody,
          ...(own(response, 'candidateBody') ? { candidateBody: response.candidateBody } : {}), expectation: response.expectation };
      }
      return result;
    });
    return { id, name, ...(owner === undefined ? {} : { owner }), criticality: consumer.criticality, interactions };
  });
  return structuredClone({ schemaVersion: 1, consumers }) as ConsumerEvidence;
}

function valid(): EvidenceValidation { return { status: 'valid', issues: [], truncated: false }; }
function issue(status: 'invalid' | 'unknown', code: string, path: string, message: string): EvidenceValidation {
  return { status, issues: [{ code, path, message }], truncated: false };
}

/** Conjunction: a known violated condition suffices for invalidity, even with unknown checks. */
function combine(results: EvidenceValidation[]): EvidenceValidation {
  const issues = results.flatMap((result) => result.issues);
  return {
    status: results.some((result) => result.status === 'invalid') ? 'invalid' : results.some((result) => result.status === 'unknown') ? 'unknown' : 'valid',
    issues: issues.slice(0, MAX_ISSUES),
    truncated: results.some((result) => result.truncated) || issues.length > MAX_ISSUES,
  };
}

function prefix(result: EvidenceValidation, path: string): EvidenceValidation {
  return { ...result, issues: result.issues.map((entry) => ({ ...entry, path: `${path}${entry.path === '#' || entry.path === '$' ? '' : entry.path.replace(/^[#$]/, '')}` })) };
}

interface Operation { operation: Node; pathItem: Node }
function findOperation(document: OpenApiDocument, interaction: ConsumerInteraction): Operation | EvidenceValidation {
  if (!record(document.paths) || !own(document.paths, interaction.path)) return issue('invalid', 'OPERATION_NOT_DECLARED', '/operation', 'The supplied operation is not declared by this contract.');
  const original = document.paths[interaction.path];
  try {
    if (pathItemReferenceConflicts(document, original).length) return issue('unknown', 'PATH_REFERENCE_AMBIGUOUS', '/operation', 'A conflicting or cyclic Path Item reference prevents an unambiguous operation check.');
    const pathItem = resolvePathItemNode(document, original);
    if (!record(pathItem)) return issue('unknown', 'INVALID_PATH_ITEM', '/operation', 'The Path Item is not understood.');
    const method = interaction.method.toLowerCase();
    if (!own(pathItem, method)) return issue('invalid', 'OPERATION_NOT_DECLARED', '/operation', 'The supplied operation is not declared by this contract.');
    const operation = pathItem[method];
    if (!record(operation) || own(operation, '$ref')) return issue('unknown', 'INVALID_OPERATION', '/operation', 'The operation shape is not understood.');
    return { operation, pathItem };
  } catch {
    return issue('unknown', 'UNRESOLVED_OPERATION_REFERENCE', '/operation', 'The operation reference could not be evaluated.');
  }
}

function resolved(document: OpenApiDocument, value: unknown): Node | undefined {
  try {
    const node = resolveNode(document, value);
    return record(node) && !own(node, '$ref') ? node : undefined;
  } catch { return undefined; }
}

function contentEntry(content: Node, requestedType: string): { kind: 'missing' | 'ambiguous' } | { kind: 'found'; value: unknown } {
  const normalized = requestedType.toLowerCase();
  const entries = Object.entries(content);
  // Do not invent negotiation; deterministic exact, type wildcard, global wildcard precedence.
  for (const name of [normalized, `${normalized.split('/')[0]}/*`, '*/*']) {
    const matches = entries.filter(([key]) => key.toLowerCase() === name);
    if (matches.length > 1) return { kind: 'ambiguous' };
    if (matches.length === 1) return { kind: 'found', value: matches[0]![1] };
  }
  return { kind: 'missing' };
}

function evaluate(value: unknown, schema: unknown, options: Parameters<typeof validateEvidenceValue>[2], budget: WorkBudget): EvidenceValidation {
  if (--budget.schemaEvaluations < 0) return { ...issue('unknown', 'EVIDENCE_WORK_LIMIT', '', 'The analysis reached its shared schema-evaluation budget; remaining evidence was not verified.'), truncated: true };
  return validateEvidenceValue(value, schema, options);
}

function schemaBody(document: OpenApiDocument, body: unknown, content: unknown, requestedType: string, direction: 'request' | 'response', budget: WorkBudget): EvidenceValidation {
  const path = `/${direction}/body`;
  if (!record(content)) return issue('unknown', 'CONTENT_NOT_DESCRIBED', path, 'The contract does not describe a usable content map for this body.');
  const match = contentEntry(content, requestedType);
  if (match.kind === 'ambiguous') return issue('unknown', 'AMBIGUOUS_MEDIA_TYPE', `/${direction}/mediaType`, 'Case-colliding media declarations prevent an unambiguous body check.');
  if (match.kind === 'missing') return issue('invalid', 'MEDIA_TYPE_NOT_DECLARED', `/${direction}/mediaType`, 'The supplied media type is not declared by this contract.');
  const media = (match as { kind: 'found'; value: unknown }).value;
  if (!record(media)) return issue('unknown', 'INVALID_MEDIA_OBJECT', path, 'The media type object is not understood.');
  const results = [prefix(evaluate(body, media.schema, { document, direction }, budget), path)];
  if (own(media, 'encoding') && (!record(media.encoding) || Object.keys(media.encoding).length > 0)) results.push(issue('unknown', 'ENCODING_NOT_VALIDATED', path, 'Multipart and form encoding semantics are not exercised by decoded JSON examples.'));
  if (!requestedType.endsWith('/json') && !requestedType.endsWith('+json')) results.push(issue('unknown', 'NON_JSON_WIRE_FORMAT', path, 'Non-JSON wire representation is not exercised by this JSON evidence runner.'));
  return combine(results);
}

function requestValidation(document: OpenApiDocument, interaction: ConsumerInteraction, request: ConsumerRequestExample, budget: WorkBudget): EvidenceValidation {
  const found = findOperation(document, interaction);
  if ('status' in found) return found;
  const { pathItem, operation } = found;
  const results: EvidenceValidation[] = [];
  const parameters = new Map<string, Node>();
  for (const source of [pathItem, operation]) {
    if (source.parameters === undefined) continue;
    if (!Array.isArray(source.parameters)) { results.push(issue('unknown', 'INVALID_PARAMETERS', '/request/parameters', 'The parameter list is not understood.')); continue; }
    const seen = new Set<string>();
    for (const raw of source.parameters) {
      if (--budget.parameterDefinitions < 0) {
        results.push({ ...issue('unknown', 'EVIDENCE_WORK_LIMIT', '/request/parameters', 'The analysis reached its shared parameter-definition budget; remaining definitions were not verified.'), truncated: true });
        break;
      }
      const parameter = resolved(document, raw);
      if (!parameter || typeof parameter.name !== 'string' || !LOCATIONS.includes(parameter.in as typeof LOCATIONS[number])) {
        results.push(issue('unknown', 'INVALID_PARAMETER', '/request/parameters', 'A parameter definition or reference is not understood.')); continue;
      }
      const identity = `${parameter.in}:${parameter.in === 'header' ? parameter.name.toLowerCase() : parameter.name}`;
      if (seen.has(identity)) results.push(issue('unknown', 'DUPLICATE_PARAMETER', '/request/parameters', 'The contract declares duplicate parameters at the same level.'));
      seen.add(identity);
      parameters.set(identity, parameter);
    }
  }
  const suppliedKeys = Object.fromEntries(LOCATIONS.map((location) => [location,
    new Map(Object.keys(request.parameters?.[location] ?? {}).map((key) => [location === 'header' ? key.toLowerCase() : key, key])),
  ])) as Record<typeof LOCATIONS[number], Map<string, string>>;
  for (const parameter of parameters.values()) {
    const location = parameter.in as typeof LOCATIONS[number];
    const name = parameter.name as string;
    // OpenAPI ignores header parameters with these names; auth is checked independently below.
    if (location === 'header' && ['accept', 'content-type', 'authorization'].includes(name.toLowerCase())) continue;
    const supplied = request.parameters?.[location] ?? {};
    const key = suppliedKeys[location].get(location === 'header' ? name.toLowerCase() : name);
    const at = `/request/parameters/${location}/${pointer(name)}`;
    if (location === 'path' && parameter.required !== true) {
      results.push(issue('unknown', 'INVALID_PATH_PARAMETER_REQUIRED', at, 'OpenAPI requires path parameters to declare required: true; this malformed definition cannot establish a migration failure.'));
      continue;
    }
    if ((own(parameter, 'schema') && own(parameter, 'content'))
      || (!own(parameter, 'schema') && !own(parameter, 'content'))
      || (own(parameter, 'schema') && typeof parameter.schema !== 'boolean' && !record(parameter.schema))) {
      results.push(issue('unknown', 'INVALID_PARAMETER_SCHEMA', at, 'A parameter must have one usable schema or content definition.'));
      continue;
    }
    if (parameter.required !== undefined && typeof parameter.required !== 'boolean') results.push(issue('unknown', 'INVALID_PARAMETER_REQUIRED', at, 'The required flag is not a boolean.'));
    if (key === undefined) {
      if (parameter.required === true || location === 'path') results.push(issue('invalid', 'REQUIRED_PARAMETER_MISSING', at, 'A required parameter is absent from the supplied request example.'));
      continue;
    }
    if (own(parameter, 'content')) {
      results.push(issue('unknown', 'PARAMETER_CONTENT_NOT_VALIDATED', at, 'Content-based parameter encoding is not evaluated by decoded parameter examples.'));
    } else results.push(prefix(evaluate(supplied[key], parameter.schema, { document, direction: 'request' }, budget), at));
    if (own(parameter, 'style') || own(parameter, 'explode') || parameter.allowReserved === true) results.push(issue('unknown', 'PARAMETER_SERIALIZATION_NOT_VALIDATED', at, 'Explicit parameter serialization rules require a wire-level test.'));
  }
  // Undeclared parameters are not necessarily forbidden by OpenAPI, so do not invent a failure.
  for (const location of LOCATIONS) for (const name of Object.keys(request.parameters?.[location] ?? {})) {
    if (location === 'header' && ['accept', 'content-type', 'authorization'].includes(name.toLowerCase())) continue;
    const identity = `${location}:${location === 'header' ? name.toLowerCase() : name}`;
    if (!parameters.has(identity)) results.push(issue('unknown', 'UNDECLARED_PARAMETER', `/request/parameters/${location}/${pointer(name)}`, 'This supplied parameter is not described by the contract; its acceptance cannot be inferred.'));
  }
  // A template variable without a matching declaration is a malformed contract, not a pass.
  for (const match of interaction.path.matchAll(/\{([^{}]+)\}/g)) {
    if (!parameters.has(`path:${match[1]}`)) results.push(issue('unknown', 'UNDECLARED_PATH_PARAMETER', '/request/parameters/path', 'A path template variable has no matching parameter declaration.'));
  }
  const hasBody = own(request, 'body');
  if (operation.requestBody === undefined) {
    if (hasBody) results.push(issue('unknown', 'REQUEST_BODY_NOT_DESCRIBED', '/request/body', 'The contract does not describe whether this supplied request body is accepted.'));
  } else {
    const body = resolved(document, operation.requestBody);
    if (!body) results.push(issue('unknown', 'INVALID_REQUEST_BODY', '/request/body', 'The request body definition or reference is not understood.'));
    else {
      if (!record(body.content)) results.push(issue('unknown', 'INVALID_REQUEST_BODY_CONTENT', '/request/body', 'A request body definition must provide a content map.'));
      if (body.required !== undefined && typeof body.required !== 'boolean') results.push(issue('unknown', 'INVALID_BODY_REQUIRED', '/request/body', 'The request body required flag is not a boolean.'));
      if (!hasBody && body.required === true) results.push(issue('invalid', 'REQUIRED_BODY_MISSING', '/request/body', 'The request example omits a required body.'));
      if (hasBody) results.push(schemaBody(document, request.body, body.content, request.mediaType!, 'request', budget));
    }
  }
  const security = operation.security === undefined ? document.security : operation.security;
  if (security !== undefined) {
    if (!Array.isArray(security) || security.some((requirement) => !record(requirement))) results.push(issue('unknown', 'INVALID_SECURITY_REQUIREMENT', '/request/security', 'The security requirement is not understood.'));
    else if (security.length > 0 && !security.some((requirement) => Object.keys(requirement as Node).length === 0)) results.push(issue('unknown', 'AUTHENTICATION_NOT_VALIDATED', '/request/security', 'Credential validity, scopes, and authorization are not evaluated from supplied payload examples.'));
  }
  return combine(results);
}

function responseValidation(document: OpenApiDocument, interaction: ConsumerInteraction, response: ConsumerResponseExample, side: 'baseline' | 'candidate', budget: WorkBudget): EvidenceValidation {
  const found = findOperation(document, interaction);
  if ('status' in found) return found;
  const responses = found.operation.responses;
  if (!record(responses)) return issue('unknown', 'RESPONSES_NOT_DESCRIBED', '/response', 'The contract does not describe a usable response map.');
  const status = [response.status, `${response.status[0]}XX`, 'default'].find((key) => own(responses, key));
  if (!status) return issue('invalid', 'STATUS_NOT_DECLARED', '/response/status', 'The supplied response status is not declared by this contract.');
  const definition = resolved(document, responses[status]);
  if (!definition) return issue('unknown', 'INVALID_RESPONSE', '/response', 'The response definition or reference is not understood.');
  const bodyKey = side === 'baseline' ? 'baselineBody' : 'candidateBody';
  if (!own(response, bodyKey)) return issue('unknown', 'CANDIDATE_EXAMPLE_MISSING', '/response/body', 'No candidate response example was supplied; response compatibility was not observed.');
  return combine([
    schemaBody(document, response[bodyKey], definition.content, response.mediaType, 'response', budget),
    prefix(evaluate(response[bodyKey], response.expectation, { direction: 'expectation' }, budget), '/response/expectation'),
  ]);
}

function checkStatus(baseline: EvidenceValidation, candidate: EvidenceValidation): ConsumerCheckStatus {
  if (baseline.status === 'invalid') return 'invalid-baseline';
  if (baseline.status === 'unknown' || candidate.status === 'unknown') return 'inconclusive';
  return candidate.status === 'invalid' ? 'regression' : 'pass';
}

function relates(change: Change, interaction: ConsumerInteraction): boolean {
  const path = `paths[${JSON.stringify(interaction.path)}]`;
  const operation = `${path}.${interaction.method.toLowerCase()}`;
  return change.location === path || change.location === operation || change.location.startsWith(`${operation}.`)
    || change.location.startsWith(`${path}.parameters[`) || change.location.startsWith(`${path}.parameters.`);
}

const NOTES: Record<ConsumerCheckStatus, string> = {
  pass: 'These supplied examples satisfy the implemented checks. This is not a proof for other inputs, live services, or production consumers.',
  regression: 'The baseline example satisfies the implemented checks and candidate evidence violates a known condition. This conclusion is bounded to the supplied examples.',
  'invalid-baseline': 'Baseline evidence already violates a contract or consumer assertion; repair or replace it before attributing failure to this API change.',
  inconclusive: 'Evidence is missing or a required condition is unsupported; no passing result or confirmed migration regression is claimed.',
};

/** Offline, deterministic consumer evidence checks; no network, generated data, or LLM inference. */
export function analyzeConsumerImpact(baseline: OpenApiInput, candidate: OpenApiInput, input: unknown, analysis: AnalysisResult): ConsumerImpactReport {
  const evidence = validateConsumerEvidence(input);
  const oldPrepared = prepareContract(baseline);
  const newPrepared = prepareContract(candidate);
  if ((analysis.source.old.fingerprint && analysis.source.old.fingerprint.value !== oldPrepared.fingerprint.value)
    || (analysis.source.new.fingerprint && analysis.source.new.fingerprint.value !== newPrepared.fingerprint.value)) fail('Consumer evidence must be evaluated with the same baseline and candidate as its compatibility analysis.');
  const mapped = new Set<string>();
  const budget: WorkBudget = { schemaEvaluations: 1_024, parameterDefinitions: 10_000 };
  const consumers: ConsumerImpactReport['consumers'] = evidence.consumers.map((consumer) => ({
    id: consumer.id, name: consumer.name, criticality: consumer.criticality, ...(consumer.owner === undefined ? {} : { owner: consumer.owner }),
    checks: consumer.interactions.flatMap((interaction) => {
      const relatedChangeIds = analysis.changes.filter((change) => relates(change, interaction)).map((change) => change.id);
      relatedChangeIds.forEach((id) => mapped.add(id));
      return (['request', 'response'] as const).flatMap((kind): ConsumerCheck[] => {
        if (!interaction[kind]) return [];
        const before = kind === 'request' ? requestValidation(oldPrepared.document, interaction, interaction.request!, budget) : responseValidation(oldPrepared.document, interaction, interaction.response!, 'baseline', budget);
        const after = kind === 'request' ? requestValidation(newPrepared.document, interaction, interaction.request!, budget) : responseValidation(newPrepared.document, interaction, interaction.response!, 'candidate', budget);
        const status = checkStatus(before, after);
        return [{ id: `${consumer.id}:${interaction.id}:${kind}`, interactionId: interaction.id, name: interaction.name ?? interaction.id,
          kind, method: interaction.method, path: interaction.path, status, baseline: before, candidate: after, relatedChangeIds, note: NOTES[status] }];
      });
    }),
  }));
  const checks = consumers.flatMap((consumer) => consumer.checks);
  const summary = { consumers: consumers.length, interactions: evidence.consumers.reduce((total, consumer) => total + consumer.interactions.length, 0), checks: checks.length,
    passed: checks.filter((check) => check.status === 'pass').length, regressions: checks.filter((check) => check.status === 'regression').length,
    invalidBaselines: checks.filter((check) => check.status === 'invalid-baseline').length, inconclusive: checks.filter((check) => check.status === 'inconclusive').length };
  const unmappedChangeIds = analysis.changes.filter((change) => ['breaking', 'potentially-breaking'].includes(change.severity) && !mapped.has(change.id)).map((change) => change.id);
  const migrationTasks: ConsumerImpactReport['migrationTasks'] = consumers.flatMap((consumer) => consumer.checks.filter((check) => check.status !== 'pass').map((check) => ({
    id: `MIG:${check.id}`, consumerId: consumer.id, ...(consumer.owner === undefined ? {} : { owner: consumer.owner }),
    priority: consumer.criticality === 'critical' ? 'high' as const : 'normal' as const,
    checkIds: [check.id], changeIds: check.relatedChangeIds,
    action: check.status === 'invalid-baseline' ? `Repair baseline evidence for ${check.method} ${check.path} before planning a migration.`
      : check.status === 'inconclusive' ? `Supply missing evidence or a wire-level test for ${check.method} ${check.path}; review the listed unsupported conditions.`
        : check.kind === 'request' ? `Adapt ${consumer.name}'s request or retain provider acceptance for ${check.method} ${check.path}; address the candidate validation issues.`
          : `Restore the consumer response guarantees or migrate ${consumer.name}'s response handling for ${check.method} ${check.path}; address the candidate validation issues.`,
    verification: `Re-run ${check.id} with representative, sanitized baseline and candidate evidence; require a valid baseline and no candidate validation failures. Independently test the deployed integration.`,
  }))).sort((left, right) => Number(right.priority === 'high') - Number(left.priority === 'high') || left.id.localeCompare(right.id, 'en'));
  return { schemaVersion: 1, evidenceKind: 'supplied-examples', fingerprint: fingerprintObject(evidence), summary,
    gate: summary.regressions > 0 ? 'blocked' : summary.invalidBaselines > 0 || summary.inconclusive > 0 || unmappedChangeIds.length > 0 || analysis.coverage?.status !== 'complete' ? 'review' : 'pass',
    consumers, unmappedChangeIds, migrationTasks,
    limitations: [
      'Examples and consumer assertions are user supplied, not captured or verified against a live service. Passing applies only to these finite examples.',
      'Request parameters are decoded JSON values. Network routing, HTTP serialization, authentication, response headers, timing, side effects, and end-to-end business behavior are not proven.',
      'Only exercised schema constraints are evaluated; this runner is not a full OpenAPI document validator, and omitted optional values do not exercise their schemas.',
      'Response checks compare supplied baseline and candidate bodies at the declared status and media type against both provider schemas and the same consumer assertion.',
      'Related change IDs are operation-level context, not proof of causation. Unmapped findings mean no matching consumer evidence was supplied, not that an endpoint is unused.',
      'Unsupported constraints produce inconclusive checks. The consumer gate supplements and never replaces the independent static compatibility and coverage gates.',
      'The report keeps issue paths and an evidence fingerprint, not the submitted payload bodies. Treat identifiers, owner names, and property names as potentially sensitive metadata.',
    ],
  };
}
