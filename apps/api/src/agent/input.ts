import { fingerprintObject, validateConsumerEvidence, type OpenApiInput } from '@contractguard/core';
import { validateCallerInput } from '@contractguard/caller';
import type { AgentProjectInput, AgentRunInput } from './types.js';

export class AgentError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = 'AgentError'; }
}
export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function failInput(message: string): never { throw new AgentError(400, 'INVALID_AGENT_INPUT', message); }
export function shortText(value: unknown, name: string, maximum: number, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) failInput(`${name} must be a nonempty string of at most ${maximum} characters without control characters.`);
  return value.trim();
}
function plainJson(value: unknown): void {
  const seen = new WeakSet<object>();
  let nodes = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > 200_000 || depth > 128) failInput('Agent input exceeds its JSON structure budget.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (!isRecord(item) && !Array.isArray(item)) failInput('Agent input must contain only finite JSON values.');
    if (seen.has(item)) failInput('Agent input cannot contain circular references.');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) failInput('Agent input must contain plain JSON objects.');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.getOwnPropertySymbols(item).length || Object.values(descriptors).some((entry) => entry.get || entry.set)) failInput('Agent input cannot contain accessors or symbols.');
    seen.add(item);
    if (Array.isArray(item)) {
      if (Object.keys(item).some((key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) failInput('Agent input arrays cannot have named properties.');
      for (let i = 0; i < item.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(item, i)) failInput('Agent input cannot contain sparse arrays.');
        visit(item[i], depth + 1);
      }
    } else for (const child of Object.values(item)) visit(child, depth + 1);
    seen.delete(item);
  }
  visit(value, 0);
}
function contract(value: unknown, name: string): OpenApiInput {
  if (typeof value !== 'string' && !isRecord(value)) failInput(`${name} must be explicit contract text, an object, or a file bundle.`);
  const encoded = typeof value === 'string' ? value : JSON.stringify(value);
  if (!encoded.trim() || Buffer.byteLength(encoded) > 6 * 1024 * 1024) failInput(`${name} exceeds the 6 MiB serialized input limit or is empty.`);
  if (isRecord(value) && value.kind === 'bundle' && Array.isArray(value.files)) {
    if (value.files.reduce((bytes, file) => bytes + (isRecord(file) && typeof file.content === 'string' ? Buffer.byteLength(file.content) : 5 * 1024 * 1024 + 1), 0) > 5 * 1024 * 1024) failInput(`${name} exceeds the 5 MiB contract content limit.`);
  } else if (Buffer.byteLength(encoded) > 5 * 1024 * 1024) failInput(`${name} exceeds the 5 MiB contract content limit.`);
  return value as OpenApiInput;
}
export function validateAgentInput(value: unknown): AgentRunInput {
  plainJson(value);
  if (!isRecord(value)) failInput('Agent input must be an object.');
  const fields = ['baseline', 'candidate', 'baselineName', 'candidateName', 'consumerEvidence', 'goal', 'mode', 'providerId', 'caller'];
  if (Object.keys(value).some((key) => !fields.includes(key))) failInput('Unknown agent input field.');
  const mode = value.mode ?? 'workflow';
  if (mode !== 'workflow' && mode !== 'llm') failInput('mode must be workflow or llm.');
  if (mode === 'workflow' && value.providerId !== undefined) failInput('providerId is only accepted in llm mode.');
  const providerId = value.providerId === undefined ? undefined : shortText(value.providerId, 'providerId', 64);
  if (providerId !== undefined && !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(providerId)) failInput('providerId must identify a server-configured profile.');
  const input: AgentRunInput = {
    baseline: contract(value.baseline, 'baseline'), candidate: contract(value.candidate, 'candidate'), mode,
    baselineName: shortText(value.baselineName, 'baselineName', 200, 'baseline'),
    candidateName: shortText(value.candidateName, 'candidateName', 200, 'candidate'),
    goal: shortText(value.goal, 'goal', 500, '检查 API 升级的兼容风险、调用方证据和迁移事项。'),
    ...(providerId === undefined ? {} : { providerId }),
    ...(value.consumerEvidence === undefined ? {} : { consumerEvidence: validateConsumerEvidence(value.consumerEvidence) }),
  };
  if (value.caller !== undefined) {
    if (!isRecord(value.caller) || Object.keys(value.caller).some((key) => !['files', 'scenarios', 'fieldRenames'].includes(key))) failInput('caller accepts only files, scenarios and fieldRenames; contracts come from the enclosing review.');
    const caller = validateCallerInput({ schemaVersion: 1, baseline: input.baseline, candidate: input.candidate, ...value.caller });
    input.caller = { files: caller.files, scenarios: caller.scenarios, ...(caller.fieldRenames === undefined ? {} : { fieldRenames: caller.fieldRenames }) };
  }
  // Validate fingerprints before queueing so cyclic/deep inputs never become a background 500.
  fingerprintObject(input);
  return structuredClone(input);
}

/** Project selection is separate: callers cannot override trusted registry material. */
export function validateProjectSelection(value: unknown): AgentProjectInput | null {
  plainJson(value);
  if (!isRecord(value) || value.projectId === undefined) return null;
  if (Object.keys(value).some((key) => !['projectId', 'mode', 'goal', 'providerId'].includes(key))) failInput('projectId cannot be combined with contracts, caller material, paths, commands or test configuration.');
  const projectId = shortText(value.projectId, 'projectId', 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(projectId)) failInput('projectId must identify an operator-configured project.');
  // Reuse mode/profile/goal validation without reading the filesystem.
  const checked = validateAgentInput({ baseline: {}, candidate: {}, ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'projectId')) });
  return { projectId, mode: checked.mode!, goal: checked.goal!, ...(checked.providerId === undefined ? {} : { providerId: checked.providerId }) };
}
