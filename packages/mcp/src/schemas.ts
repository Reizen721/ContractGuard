import { z } from 'zod';

const document = z.union([
  z.string().min(1).max(5 * 1024 * 1024),
  z.record(z.string(), z.unknown()),
]).describe('OpenAPI YAML/JSON text, document object, or multi-file {kind:"bundle",entry,files:[{path,content}]} (max 5 MiB). Pass contents, never file paths or URLs.');

const name = z.string().max(200).regex(/^[^\u0000-\u001F\u007F]*$/);
const profile = z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/).describe('Server-configured LLM profile ID.');
const slugId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const sourceFile = z.object({
  path: z.string().min(1).max(240),
  content: z.string().min(1).max(256 * 1024),
}).strict();

export const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).describe('Persisted ContractGuard UUID.');

export const paging = {
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(50).default(20),
};

export const reportPaging = {
  offset: z.number().int().min(0).max(32_000_000).default(0).describe('UTF-16 offset; follow nextOffset.'),
  maxCharacters: z.number().int().min(256).max(32_000).default(24_000),
};

export const empty = z.object({}).strict();

export const analysisInput = z.object({
  baseline: document,
  candidate: document,
  baselineName: name.optional(),
  candidateName: name.optional(),
  consumerEvidence: z.record(z.string(), z.unknown()).optional().describe('Optional schemaVersion:1 consumer interaction samples.'),
}).strict();

export const explanationInput = z.object({
  analysisId: id,
  language: z.enum(['zh-CN', 'en']).default('zh-CN'),
  focus: z.string().max(500).optional(),
  providerId: profile.optional(),
  force: z.boolean().default(false).describe('Return cached AI review unless true.'),
}).strict();

const callerOperation = {
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE']),
  path: z.string().min(1).max(500),
};

const callerResponse = z.object({
  status: z.number().int().min(100).max(599),
  body: z.unknown().refine((value) => value !== undefined, 'A JSON response body is required.'),
}).strict();

export const callerReviewInput = z.object({
  schemaVersion: z.literal(1),
  baseline: document,
  candidate: document,
  files: z.array(sourceFile).min(1).max(20).describe('Authorized .ts/.tsx source contents (relative paths only).'),
  scenarios: z.array(z.object({
    id: z.string().min(1).max(100),
    file: z.string().min(1).max(240),
    exportName: z.string().min(1).max(100),
    args: z.array(z.unknown()).max(16),
    operation: z.object(callerOperation).strict(),
    baselineResponse: callerResponse,
    candidateResponse: callerResponse,
    expected: z.unknown().refine((value) => value !== undefined, 'An explicit expected JSON result is required.'),
  }).strict()).max(30).describe('Bounded AST replay fixtures and expected output (no test runner required).'),
  fieldRenames: z.array(z.object({
    ...callerOperation,
    from: z.string().min(1).max(100),
    to: z.string().min(1).max(100),
  }).strict()).max(20).optional().describe('Confirmed top-level field mappings for in-memory candidate patch replay.'),
}).strict();

export const reviewInput = z.object({
  baseline: document.optional(),
  candidate: document.optional(),
  baselineName: name.optional(),
  candidateName: name.optional(),
  consumerEvidence: z.record(z.string(), z.unknown()).optional(),
  caller: callerReviewInput.pick({ files: true, scenarios: true, fieldRenames: true }).optional(),
  projectId: slugId.optional().describe('Registered project ID from list_projects; cannot be combined with explicit contracts.'),
  goal: z.string().min(1).max(500).regex(/^[^\u0000-\u001F\u007F]+$/).optional(),
  mode: z.enum(['workflow', 'llm']).default('workflow').describe('workflow is deterministic; llm uses the server-configured planner.'),
  providerId: profile.optional(),
}).strict().superRefine((value, context) => {
  if (value.projectId !== undefined) {
    if (['baseline', 'candidate', 'baselineName', 'candidateName', 'consumerEvidence', 'caller'].some((key) => value[key as keyof typeof value] !== undefined)) {
      context.addIssue({ code: 'custom', message: 'projectId cannot be combined with contract or caller overrides.' });
    }
  } else if (value.baseline === undefined || value.candidate === undefined) {
    context.addIssue({ code: 'custom', message: 'Provide both baseline and candidate, or one registered projectId.' });
  }
});

export const cegarRunInput = z.object({
  presetId: slugId.optional().describe('Built-in CEGAR preset ID from list_cegar_runs(includePresets:true); cannot be combined with explicit contracts/files.'),
  title: name.optional(),
  mode: z.enum(['symbolic', 'hybrid', 'llm']).default('symbolic').describe('symbolic uses TypeChecker AST synthesis; hybrid falls back to LLM; llm uses slice + counterexample prompts.'),
  providerId: profile.optional(),
  maxRounds: z.number().int().min(1).max(6).default(4),
  enableAdversarialFuzzing: z.boolean().default(true).describe('Enable Gate 4 differential adversarial witness crash testing (WIT-NULL/OPT/EMPTY/ENUM).'),
  baseline: document.optional(),
  candidate: document.optional(),
  callerFiles: z.array(sourceFile).min(1).max(20).optional().describe('TypeScript caller workspace files (relative paths, e.g. src/client.ts).'),
  testFiles: z.array(sourceFile).min(1).max(10).optional().describe('Node test files (node:test) exercising callerFiles.'),
  probes: z.array(z.object({
    file: z.string().min(1).max(240),
    exportName: z.string().min(1).max(120),
    args: z.array(z.unknown()).max(16).optional(),
  }).strict()).max(12).optional().describe('Entrypoints invoked against differential adversarial witnesses.'),
  seedBaselineResponses: z.record(z.string(), z.object({
    status: z.number().int().min(100).max(599).optional(),
    body: z.unknown().refine((value) => value !== undefined, 'Response body is required.'),
  }).strict()).optional().describe('Optional nominal baseline responses keyed by "METHOD /path".'),
}).strict().superRefine((value, context) => {
  const overrideKeys = ['baseline', 'candidate', 'callerFiles', 'testFiles', 'probes', 'seedBaselineResponses'] as const;
  if (value.presetId !== undefined) {
    if (overrideKeys.some((key) => value[key] !== undefined)) {
      context.addIssue({ code: 'custom', message: 'presetId cannot be combined with explicit contract or workspace overrides.' });
    }
  } else if (!value.baseline || !value.candidate || !value.callerFiles || !value.testFiles) {
    context.addIssue({ code: 'custom', message: 'Provide either presetId, or explicit baseline, candidate, callerFiles, and testFiles.' });
  }
});
