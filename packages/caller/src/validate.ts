import type { CallerImpactInput, JsonValue } from './types.js';

export const CALLER_LIMITS = Object.freeze({ files: 20, sourceBytes: 1024 * 1024, fileBytes: 256 * 1024, scenarios: 30, renames: 20, steps: 4096, depth: 40, astNodes: 40_000 });
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
export class CallerInputError extends Error {
  readonly code = 'INVALID_CALLER_INPUT';
  constructor(message: string) { super(message); this.name = 'CallerInputError'; }
}
export function fail(message: string): never { throw new CallerInputError(message); }
export function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function safeKey(key: string): boolean { return !dangerous.has(key); }
export function jsonValue(value: unknown, budget = { nodes: 0 }, depth = 0, ancestors = new Set<object>()): asserts value is JsonValue {
  if (++budget.nodes > 100_000 || depth > 80) fail('JSON input exceeds its node/depth budget.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('Numbers must be finite.'); return; }
  if (typeof value === 'string') { if (value.length > 5 * 1024 * 1024) fail('A text value exceeds 5 MiB.'); return; }
  if (typeof value !== 'object' || ancestors.has(value)) fail('Input must contain acyclic JSON values only.');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('Custom object prototypes are not accepted.');
  if (Object.getOwnPropertySymbols(value).length) fail('Symbol properties are not accepted.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.get || descriptor.set || (!descriptor.enumerable && !(Array.isArray(value) && key === 'length'))) fail('Accessors and hidden properties are not accepted.');
    if (!safeKey(key)) fail('Prototype-sensitive properties are not accepted.');
  }
  if (Array.isArray(value) && (Object.keys(value).length !== value.length || !Object.keys(value).every((key) => /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < value.length))) fail('Arrays must be dense JSON arrays.');
  const next = new Set(ancestors); next.add(value);
  for (const key of Object.keys(value)) jsonValue((value as Record<string, unknown>)[key], budget, depth + 1, next);
}
function fields(value: Record<string, unknown>, names: string[], label: string): void {
  if (Object.keys(value).some((key) => !names.includes(key))) fail(`Unsupported ${label} field.`);
}
function text(value: unknown, max: number, label: string): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} must be a nonempty printable string of at most ${max} characters.`);
}
export function validateCallerPath(value: unknown): asserts value is string {
  text(value, 240, 'Source path');
  if (value.startsWith('/') || /[\\:%?#]/.test(value) || !/\.(?:ts|tsx)$/.test(value) || value.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('Source paths must be unambiguous relative .ts/.tsx paths with forward slashes.');
}
function operation(value: unknown): void {
  if (!record(value)) fail('operation must be an object.');
  fields(value, ['method', 'path'], 'operation');
  if (typeof value.method !== 'string' || !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)$/.test(value.method)) fail('operation.method must be an uppercase HTTP method.');
  text(value.path, 500, 'operation.path');
  if (!value.path.startsWith('/') || /[?#]/.test(value.path)) fail('operation.path must be an exact OpenAPI path template.');
}
export function validateCallerInput(input: unknown): CallerImpactInput {
  jsonValue(input);
  if (!record(input)) fail('Caller input must be an object.');
  fields(input, ['schemaVersion', 'baseline', 'candidate', 'files', 'scenarios', 'fieldRenames'], 'caller input');
  if (input.schemaVersion !== 1) fail('schemaVersion must be 1.');
  for (const side of ['baseline', 'candidate']) {
    const value = input[side];
    if (!(typeof value === 'string' && value.trim() || record(value))) fail(`${side} must contain an OpenAPI document or explicit bundle.`);
    if (Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8') > 5 * 1024 * 1024) fail(`${side} exceeds 5 MiB.`);
  }
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > CALLER_LIMITS.files) fail('files must contain 1–20 explicit source files.');
  const paths = new Set<string>(); let bytes = 0;
  for (const file of input.files) {
    if (!record(file)) fail('A source file must be an object.'); fields(file, ['path', 'content'], 'source file'); validateCallerPath(file.path);
    const identity = file.path.toLowerCase(); if (paths.has(identity)) fail('Duplicate or case-ambiguous source path.'); paths.add(identity);
    if (typeof file.content !== 'string' || !file.content.trim()) fail('Source file content must be nonempty text.');
    const size = Buffer.byteLength(file.content, 'utf8'); bytes += size;
    if (size > CALLER_LIMITS.fileBytes || bytes > CALLER_LIMITS.sourceBytes) fail('Source budget exceeded: 256 KiB per file, 1 MiB total.');
  }
  if (!Array.isArray(input.scenarios) || input.scenarios.length > CALLER_LIMITS.scenarios) fail('scenarios must be an array with at most 30 items.');
  const ids = new Set<string>();
  for (const scenario of input.scenarios) {
    if (!record(scenario)) fail('Each scenario must be an object.');
    fields(scenario, ['id', 'file', 'exportName', 'args', 'operation', 'baselineResponse', 'candidateResponse', 'expected'], 'scenario');
    text(scenario.id, 100, 'Scenario ID'); if (ids.has(scenario.id)) fail('Duplicate scenario ID.'); ids.add(scenario.id);
    validateCallerPath(scenario.file); if (!input.files.some((file) => (file as Record<string, unknown>).path === scenario.file)) fail('Scenario file must exactly name a submitted source file.');
    text(scenario.exportName, 100, 'exportName'); if (!/^[A-Za-z_$][\w$]*$/.test(scenario.exportName) || !safeKey(scenario.exportName)) fail('exportName must be a safe named export.');
    if (!Array.isArray(scenario.args) || scenario.args.length > 16) fail('Scenario args must contain at most 16 JSON values.'); operation(scenario.operation);
    for (const side of ['baselineResponse', 'candidateResponse']) {
      const response = scenario[side]; if (!record(response)) fail(`${side} must be an object.`);
      fields(response, ['status', 'body'], side);
      if (!Number.isInteger(response.status) || (response.status as number) < 100 || (response.status as number) > 599 || !Object.hasOwn(response, 'body')) fail(`${side} needs status 100–599 and an explicit JSON body.`);
    }
    if (!Object.hasOwn(scenario, 'expected')) fail('Every scenario needs an explicit expected JSON output.');
    if (Buffer.byteLength(JSON.stringify(scenario)) > 128 * 1024) fail('Each scenario must be at most 128 KiB.');
  }
  if (input.fieldRenames !== undefined) {
    if (!Array.isArray(input.fieldRenames) || input.fieldRenames.length > CALLER_LIMITS.renames) fail('fieldRenames must contain at most 20 mappings.');
    const mappings = new Set<string>();
    for (const rename of input.fieldRenames) {
      if (!record(rename)) fail('Each field rename must be an object.'); fields(rename, ['method', 'path', 'from', 'to'], 'rename'); operation({ method: rename.method, path: rename.path });
      for (const key of ['from', 'to']) if (typeof rename[key] !== 'string' || !/^[A-Za-z_$][\w$]{0,99}$/.test(rename[key] as string) || !safeKey(rename[key] as string)) fail('Renames support safe top-level identifier property names only.');
      if (rename.from === rename.to) fail('Rename source and target must differ.');
      const identity = `${rename.method} ${rename.path} ${rename.from}`; if (mappings.has(identity)) fail('Duplicate/conflicting field rename.'); mappings.add(identity);
    }
  }
  return structuredClone(input) as unknown as CallerImpactInput;
}
