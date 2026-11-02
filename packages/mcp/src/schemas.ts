import { z } from 'zod';

const document = z.union([
  z.string().min(1).max(5 * 1024 * 1024),
  z.record(z.string(), z.unknown()),
]).describe('Explicit OpenAPI YAML/JSON text, a document object, or {kind:"bundle",entry:"openapi.yaml",files:[{path:"openapi.yaml",content:"..."},...]}. All referenced local files must be submitted (1-50 files, total 5 MiB per side). Never pass a path/URL in place of contents.');
const name = z.string().max(200).regex(/^[^\u0000-\u001F\u007F]*$/);
const profile = z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/).describe('Existing server-configured profile ID; no model, URL or key can be supplied here.');
export const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).describe('Persisted UUID returned by ContractGuard.');
export const paging = {
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(50).default(20),
};
export const reportPaging = {
  offset: z.number().int().min(0).max(32_000_000).default(0).describe('UTF-16 text offset; use nextOffset from the previous chunk.'),
  maxCharacters: z.number().int().min(256).max(32_000).default(24_000),
};
export const analysisInput = z.object({
  baseline: document,
  candidate: document,
  baselineName: name.optional(),
  candidateName: name.optional(),
  consumerEvidence: z.record(z.string(), z.unknown()).optional().describe('Optional existing ContractGuard consumer evidence object, schemaVersion:1. Submit only authorized samples. The service validates its structure and limits.'),
}).strict();
export const explanationInput = z.object({
  analysisId: id,
  language: z.enum(['zh-CN', 'en']).default('zh-CN'),
  focus: z.string().max(500).optional(),
  providerId: profile.optional(),
  force: z.boolean().default(false).describe('Reuse a saved explanation by default. true explicitly requests regeneration and may incur another model charge.'),
}).strict();

export const empty = z.object({}).strict();

const callerOperation = {
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE']),
  path: z.string().min(1).max(500),
};
const callerResponse = z.object({ status: z.number().int().min(100).max(599), body: z.unknown().refine((value) => value !== undefined, 'A JSON response body is required.') }).strict();
export const callerReviewInput = z.object({
  schemaVersion: z.literal(1), baseline: document, candidate: document,
  files: z.array(z.object({ path: z.string().min(1).max(240), content: z.string().min(1).max(256 * 1024) }).strict()).min(1).max(20)
    .describe('Explicit authorized .ts/.tsx source contents. Relative paths only; at most 256 KiB per file and 1 MiB total UTF-8 source. No disk paths are read by the service.'),
  scenarios: z.array(z.object({
    id: z.string().min(1).max(100), file: z.string().min(1).max(240), exportName: z.string().min(1).max(100),
    args: z.array(z.unknown()).max(16), operation: z.object(callerOperation).strict(),
    baselineResponse: callerResponse, candidateResponse: callerResponse,
    expected: z.unknown().refine((value) => value !== undefined, 'An explicit expected JSON result is required.'),
  }).strict()).max(30).describe('Explicit response fixtures and expected output for an exported function. This is bounded AST replay, not a live endpoint or full Node test.'),
  fieldRenames: z.array(z.object({ ...callerOperation, from: z.string().min(1).max(100), to: z.string().min(1).max(100) }).strict()).max(20).optional()
    .describe('Operator-confirmed top-level response field mappings. Never invent semantic equivalence; patches remain in-memory proposals, not source edits.'),
}).strict();

export const reviewInput = z.object({
  baseline: document.optional(), candidate: document.optional(), baselineName: name.optional(), candidateName: name.optional(),
  consumerEvidence: z.record(z.string(), z.unknown()).optional(),
  caller: callerReviewInput.pick({ files: true, scenarios: true, fieldRenames: true }).optional().describe('Optional explicit source/scenario material. Uses the enclosing baseline/candidate; cannot override contracts. Enables mandatory caller-analysis.'),
  projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/).optional().describe('Only an ID returned by list_projects. The operator-configured registry supplies contracts, existing fixtures and trusted tests; no paths, commands or overrides are accepted.'),
  goal: z.string().min(1).max(500).regex(/^[^\u0000-\u001F\u007F]+$/).optional(),
  mode: z.enum(['workflow', 'llm']).default('workflow').describe('workflow runs local checks without a model. llm invokes the configured model; registered project tests run in both modes under operator trust.'),
  providerId: profile.optional(),
}).strict().superRefine((value, context) => {
  if (value.projectId !== undefined) {
    if (['baseline', 'candidate', 'baselineName', 'candidateName', 'consumerEvidence', 'caller'].some((key) => value[key as keyof typeof value] !== undefined)) context.addIssue({ code: 'custom', message: 'projectId cannot be combined with contract or caller overrides.' });
  } else if (value.baseline === undefined || value.candidate === undefined) context.addIssue({ code: 'custom', message: 'Provide both baseline and candidate, or one registered projectId.' });
});
