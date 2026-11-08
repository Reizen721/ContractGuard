import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import {
  analyzeRelease,
  ContractGuardError,
  ENGINE_VERSION,
  ruleCatalog,
  validateRulePolicy,
  type RulePolicy,
} from '@contractguard/core';
import type { AiRuntimeConfig } from './ai/config.js';
import { createDeepSeekAiService, type DeepSeekAiConfig } from './ai/deepseek.js';
import { createMultiProviderAiService } from './ai/service.js';
import { AiReviewCoordinator } from './ai/review-coordinator.js';
import { AiReviewStore } from './ai/review-store.js';
import { renderAiReview } from './ai/review-report.js';
import { AiServiceError, type AiReviewLanguage, type AiReviewRequest, type AiReviewService } from './ai/types.js';
import { renderReport, type ReportFormat } from './reports.js';
import { AnalysisStore } from './store.js';
import type { ApiErrorBody, StoredAnalysis } from './types.js';
import { createAgentRouter } from './agent/router.js';
import { createCallerRouter } from './caller/router.js';
import { createCegarRouter } from './cegar/router.js';

export interface AppOptions {
  dataDirectory?: string;
  corsOrigin?: string;
  maxSpecBytes?: number;
  serveWeb?: boolean;
  aiService?: AiReviewService;
  aiFetch?: typeof globalThis.fetch;
  /** Backwards-compatible DeepSeek-only programmatic configuration. */
  aiConfig?: Partial<DeepSeekAiConfig>;
  aiRuntimeConfig?: AiRuntimeConfig;
  aiConfigPath?: string;
  aiEnvironment?: NodeJS.ProcessEnv;
  rulePolicy?: RulePolicy;
  oasdiffPath?: string;
  projectConfigPath?: string;
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();
  const dataDirectory = options.dataDirectory ?? process.env.CONTRACTGUARD_DATA_DIR ?? './data/analyses';
  const maxSpecBytes = options.maxSpecBytes ?? numberFromEnv('CONTRACTGUARD_MAX_SPEC_BYTES', 5 * 1024 * 1024);
  const store = new AnalysisStore(dataDirectory);
  const allowedOrigins = corsOrigins(options.corsOrigin ?? process.env.CORS_ORIGIN);
  const rulePolicy = options.rulePolicy ?? loadRulePolicy(process.env.CONTRACTGUARD_POLICY_CONFIG);
  const aiService = options.aiService ?? (options.aiConfig === undefined && options.aiRuntimeConfig === undefined
    ? createMultiProviderAiService({
      ...(options.aiFetch === undefined ? {} : { fetch: options.aiFetch }),
      ...(options.aiConfigPath === undefined ? {} : { configPath: options.aiConfigPath }),
      ...(options.aiEnvironment === undefined ? {} : { environment: options.aiEnvironment }),
    })
    : options.aiRuntimeConfig !== undefined
      ? createMultiProviderAiService({
        config: options.aiRuntimeConfig,
        ...(options.aiFetch === undefined ? {} : { fetch: options.aiFetch }),
        ...(options.aiEnvironment === undefined ? {} : { environment: options.aiEnvironment }),
      })
      : createDeepSeekAiService({
        ...(options.aiFetch === undefined ? {} : { fetch: options.aiFetch }),
        config: options.aiConfig!,
      }));
  const reviewStore = new AiReviewStore(dataDirectory);
  const reviewCoordinator = new AiReviewCoordinator(aiService, reviewStore);

  app.disable('x-powered-by');
  app.use(cors({
    origin(origin, callback) {
      callback(null, origin === undefined || allowedOrigins.has('*') || allowedOrigins.has(origin));
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  }));
  // Caller reviews add explicit source and up to 30 bounded response scenarios.
  // Per-field UTF-8 limits remain enforced by each engine after JSON parsing.
  app.use(express.json({ limit: maxSpecBytes * 2 + 10 * 1024 * 1024 }));
  app.use('/api/caller-reviews', createCallerRouter({
    dataDirectory: join(dataDirectory, 'caller-reviews'),
    onExecutor: (executor) => { app.locals.closeCaller = () => executor.close(); },
  }));
  app.use('/api/agent', createAgentRouter({
    dataDirectory: join(dataDirectory, 'agent-runs'),
    callerDataDirectory: join(dataDirectory, 'caller-reviews'),
    ...(options.projectConfigPath === undefined ? {} : { projectConfigPath: options.projectConfigPath }),
    onManager: (manager) => { app.locals.closeAgent = () => manager.close(); },
    ...(options.oasdiffPath === undefined ? {} : { oasdiffPath: options.oasdiffPath }),
    ...(options.aiConfig === undefined ? {} : { aiConfig: options.aiConfig }),
    ...(options.aiRuntimeConfig === undefined ? {} : { aiRuntimeConfig: options.aiRuntimeConfig }),
    ...(options.aiConfigPath === undefined ? {} : { aiConfigPath: options.aiConfigPath }),
    ...(options.aiEnvironment === undefined ? {} : { aiEnvironment: options.aiEnvironment }),
    ...(options.aiFetch === undefined ? {} : { aiFetch: options.aiFetch }),
  }));
  app.use('/api/cegar', createCegarRouter({
    dataDirectory: join(dataDirectory, 'cegar-runs'),
    ...(options.aiConfig === undefined ? {} : { aiConfig: options.aiConfig }),
    ...(options.aiRuntimeConfig === undefined ? {} : { aiRuntimeConfig: options.aiRuntimeConfig }),
    ...(options.aiConfigPath === undefined ? {} : { aiConfigPath: options.aiConfigPath }),
    ...(options.aiEnvironment === undefined ? {} : { aiEnvironment: options.aiEnvironment }),
    ...(options.aiFetch === undefined ? {} : { aiFetch: options.aiFetch }),
  }));

  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok', service: 'contractguard-api', version: ENGINE_VERSION });
  });

  app.get('/api/rules', (_request, response) => {
    response.json({ rules: ruleCatalog });
  });

  app.get('/api/ai/status', (_request, response) => {
    response.json(aiService.status());
  });

  app.get('/api/analyses', asyncHandler(async (_request, response) => {
    response.json({ analyses: await store.list() });
  }));

  app.get('/api/analyses/:id', asyncHandler(async (request, response) => {
    const analysis = await store.get(routeId(request.params.id));
    if (!analysis) throw httpError(404, 'ANALYSIS_NOT_FOUND', 'The requested analysis does not exist.');
    response.json(analysis);
  }));

  app.post('/api/analyses', asyncHandler(async (request, response) => {
    if (!isPlainObject(request.body)) {
      throw httpError(400, 'INVALID_REQUEST', 'The request body must be a JSON object. Set Content-Type to application/json.');
    }
    const { baseline, candidate, baselineName, candidateName, consumerEvidence } = request.body;
    const fields = new Set(['baseline', 'candidate', 'baselineName', 'candidateName', 'consumerEvidence']);
    if (Object.keys(request.body).some((field) => !fields.has(field))) {
      throw httpError(400, 'INVALID_REQUEST', 'Unsupported analysis field. Use consumerEvidence for optional consumer examples.');
    }
    validateSpecInput(baseline, 'baseline', maxSpecBytes);
    validateSpecInput(candidate, 'candidate', maxSpecBytes);
    validateName(baselineName, 'baselineName');
    validateName(candidateName, 'candidateName');

    const createdAt = new Date().toISOString();
    const result = analyzeRelease(
      baseline as string | Record<string, unknown>,
      candidate as string | Record<string, unknown>,
      { ...(rulePolicy === undefined ? {} : { policy: rulePolicy }), ...(consumerEvidence === undefined ? {} : { consumerEvidence }) },
    );
    const analysis: StoredAnalysis = {
      ...result,
      id: randomUUID(),
      baselineName: typeof baselineName === 'string' && baselineName.trim() ? baselineName.trim() : contractName(baseline, 'baseline.yaml'),
      candidateName: typeof candidateName === 'string' && candidateName.trim() ? candidateName.trim() : contractName(candidate, 'candidate.yaml'),
      createdAt,
    };
    await store.save(analysis);
    response.status(201).json(analysis);
  }));

  app.post('/api/analyses/:id/ai-review', asyncHandler(async (request, response) => {
    const controller = new AbortController();
    const abortUpstream = (): void => {
      if (!response.writableEnded) controller.abort();
    };
    request.once('aborted', abortUpstream);
    response.once('close', abortUpstream);
    try {
      // The client may have disconnected before these listeners were attached.
      if (request.aborted || response.destroyed) controller.abort();
      if (controller.signal.aborted) return;

      const analysis = await store.get(routeId(request.params.id));
      if (controller.signal.aborted) return;
      if (!analysis) throw httpError(404, 'ANALYSIS_NOT_FOUND', 'The requested analysis does not exist.');
      const aiRequest = validateAiReviewRequest(request.body);
      const review = await reviewCoordinator.review(analysis, aiRequest, controller.signal);
      if (!controller.signal.aborted) response.json(review);
    } catch (error) {
      if (controller.signal.aborted && (request.aborted || response.destroyed)) return;
      throw error;
    } finally {
      request.off('aborted', abortUpstream);
      response.off('close', abortUpstream);
    }
  }));

  app.get('/api/analyses/:id/ai-reviews', asyncHandler(async (request, response) => {
    const id = routeId(request.params.id);
    const analysis = await store.get(id);
    if (!analysis) throw httpError(404, 'ANALYSIS_NOT_FOUND', 'The requested analysis does not exist.');
    response.json({ reviews: await reviewStore.list(id) });
  }));

  app.get('/api/analyses/:id/ai-reviews/:reviewId/report', asyncHandler(async (request, response) => {
    const id = routeId(request.params.id);
    const analysis = await store.get(id);
    if (!analysis) throw httpError(404, 'ANALYSIS_NOT_FOUND', 'The requested analysis does not exist.');
    const format = String(request.query.format ?? 'json');
    if (format !== 'json' && format !== 'markdown') {
      throw httpError(400, 'INVALID_REPORT_FORMAT', 'AI report format must be json or markdown.');
    }
    const review = await reviewStore.get(id, routeId(request.params.reviewId));
    if (!review) throw httpError(404, 'AI_REVIEW_NOT_FOUND', 'The requested AI review does not exist.');
    response.setHeader('Content-Type', format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="contractguard-ai-${review.id}.${format === 'json' ? 'json' : 'md'}"`);
    response.send(renderAiReview(review, format));
  }));

  app.get('/api/analyses/:id/report', asyncHandler(async (request, response) => {
    const format = String(request.query.format ?? 'json') as ReportFormat;
    if (!['json', 'markdown', 'html'].includes(format)) {
      throw httpError(400, 'INVALID_REPORT_FORMAT', 'Report format must be json, markdown, or html.');
    }
    const analysis = await store.get(routeId(request.params.id));
    if (!analysis) throw httpError(404, 'ANALYSIS_NOT_FOUND', 'The requested analysis does not exist.');
    const contentTypes: Record<ReportFormat, string> = {
      json: 'application/json; charset=utf-8',
      markdown: 'text/markdown; charset=utf-8',
      html: 'text/html; charset=utf-8',
    };
    const extensions: Record<ReportFormat, string> = { json: 'json', markdown: 'md', html: 'html' };
    response.setHeader('Content-Type', contentTypes[format]);
    response.setHeader('Content-Disposition', `attachment; filename="contractguard-${analysis.id}.${extensions[format]}"`);
    response.send(renderReport(analysis, format));
  }));

  app.delete('/api/analyses/:id', asyncHandler(async (request, response) => {
    const id = routeId(request.params.id);
    if (!(await store.get(id))) {
      throw httpError(404, 'ANALYSIS_NOT_FOUND', 'The requested analysis does not exist.');
    }
    await reviewCoordinator.discardAnalysis(id);
    await store.delete(id);
    response.status(204).send();
  }));

  if (options.serveWeb !== false) {
    const currentDirectory = dirname(fileURLToPath(import.meta.url));
    const webDist = resolve(currentDirectory, '../../web/dist');
    if (existsSync(webDist)) {
      app.use(express.static(webDist));
      app.get(/^(?!\/api).*/, (_request, response) => response.sendFile(resolve(webDist, 'index.html')));
    }
  }

  app.use('/api', (_request, response) => {
    response.status(404).json(errorBody('ROUTE_NOT_FOUND', 'The requested API route does not exist.'));
  });

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    const normalized = normalizeError(error);
    if (normalized.status >= 500) console.error(error);
    response.status(normalized.status).json(errorBody(normalized.code, normalized.message, normalized.details));
  };
  app.use(errorHandler);

  return app;
}

function asyncHandler(handler: (request: express.Request, response: express.Response) => Promise<void>): RequestHandler {
  return (request, response, next) => void handler(request, response).catch(next);
}

function validateSpecInput(value: unknown, field: string, maxBytes: number): asserts value is string | Record<string, unknown> {
  if (typeof value !== 'string' && !isPlainObject(value)) {
    throw httpError(400, 'INVALID_REQUEST', `${field} must be an OpenAPI document encoded as YAML/JSON text or a JSON object.`);
  }
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (!serialized.trim()) throw httpError(400, 'INVALID_REQUEST', `${field} cannot be empty.`);
  let size = Buffer.byteLength(serialized, 'utf8');
  if (isPlainObject(value) && value.kind === 'bundle') {
    if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > 50
      || !value.files.every((file) => isPlainObject(file) && typeof file.content === 'string')) {
      throw httpError(400, 'INVALID_BUNDLE', `${field}.files must contain 1-50 explicit text files.`);
    }
    size = value.files.reduce((total, file) => total + Buffer.byteLength((file as { content: string }).content, 'utf8'), 0);
  }
  if (size > maxBytes) {
    throw httpError(413, 'SPEC_TOO_LARGE', `${field} exceeds the configured ${maxBytes}-byte limit.`);
  }
}

function contractName(value: unknown, fallback: string): string {
  return isPlainObject(value) && value.kind === 'bundle' && typeof value.entry === 'string'
    ? value.entry.slice(0, 200) : fallback;
}

function routeId(value: string | string[] | undefined): string {
  if (typeof value !== 'string') throw httpError(400, 'INVALID_ANALYSIS_ID', 'Invalid analysis identifier.');
  return value;
}

function validateName(value: unknown, field: string): void {
  if (value !== undefined && (
    typeof value !== 'string'
    || value.length > 200
    || /[\u0000-\u001F\u007F]/.test(value)
  )) {
    throw httpError(400, 'INVALID_REQUEST', `${field} must be a string no longer than 200 characters and contain no control characters.`);
  }
}

function validateAiReviewRequest(value: unknown): AiReviewRequest {
  if (value === undefined) return { language: 'zh-CN' };
  if (!isPlainObject(value)) {
    throw httpError(400, 'INVALID_AI_REVIEW_REQUEST', 'The AI review request body must be a JSON object.');
  }
  const unexpected = Object.keys(value).find((key) => key !== 'language' && key !== 'focus' && key !== 'providerId' && key !== 'force');
  if (unexpected !== undefined) {
    throw httpError(400, 'INVALID_AI_REVIEW_REQUEST', `Unsupported AI review field: ${unexpected}.`);
  }
  const language = value.language ?? 'zh-CN';
  if (language !== 'zh-CN' && language !== 'en') {
    throw httpError(400, 'INVALID_AI_REVIEW_REQUEST', 'language must be zh-CN or en.');
  }
  if (value.focus !== undefined && (typeof value.focus !== 'string' || value.focus.length > 500)) {
    throw httpError(400, 'INVALID_AI_REVIEW_REQUEST', 'focus must be a string no longer than 500 characters.');
  }
  if (value.force !== undefined && typeof value.force !== 'boolean') {
    throw httpError(400, 'INVALID_AI_REVIEW_REQUEST', 'force must be a boolean.');
  }
  if (value.providerId !== undefined && (
    typeof value.providerId !== 'string'
    || !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(value.providerId)
  )) {
    throw httpError(
      400,
      'INVALID_AI_REVIEW_REQUEST',
      'providerId must be a configured profile identifier no longer than 64 characters.',
    );
  }
  const focus = typeof value.focus === 'string' ? value.focus.trim() : undefined;
  return {
    language: language as AiReviewLanguage,
    ...(focus ? { focus } : {}),
    ...(typeof value.providerId === 'string' ? { providerId: value.providerId } : {}),
    ...(value.force === undefined ? {} : { force: value.force as boolean }),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function httpError(status: number, code: string, message: string, details?: unknown): Error {
  return Object.assign(new Error(message), { status, code, details });
}

function normalizeError(error: unknown): { status: number; code: string; message: string; details?: unknown } {
  if (error instanceof SyntaxError && 'type' in error && error.type === 'entity.parse.failed') {
    return { status: 400, code: 'INVALID_JSON', message: 'The request body is not valid JSON.' };
  }
  if (error instanceof Error && 'type' in error && error.type === 'entity.too.large') {
    return { status: 413, code: 'REQUEST_TOO_LARGE', message: 'The request body exceeds the configured size limit.' };
  }
  if (error instanceof ContractGuardError) {
    return { status: 400, code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  }
  if (error instanceof AiServiceError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    const candidate = error as Error & { status?: number; code?: string; details?: unknown };
    const status = candidate.status && candidate.status >= 400 && candidate.status < 600 ? candidate.status : 500;
    if (status >= 500) {
      return { status, code: 'INTERNAL_ERROR', message: 'The server could not complete the request.' };
    }
    return {
      status,
      code: candidate.code ?? 'INVALID_OPENAPI_DOCUMENT',
      message: candidate.message || 'The request could not be processed.',
      ...(candidate.details === undefined ? {} : { details: candidate.details }),
    };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' };
}

function errorBody(code: string, message: string, details?: unknown): ApiErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

function numberFromEnv(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function corsOrigins(configured: string | undefined): Set<string> {
  const value = configured ?? 'http://localhost:5173,http://127.0.0.1:5173';
  return new Set(value.split(',').map((origin) => origin.trim()).filter(Boolean));
}

function loadRulePolicy(pathValue: string | undefined): RulePolicy | undefined {
  const configuredPath = pathValue?.trim();
  if (!configuredPath) return undefined;
  const absolutePath = resolve(configuredPath);
  let text: string;
  try {
    const stats = statSync(absolutePath);
    if (!stats.isFile()) throw new Error('not a file');
    if (stats.size > 64 * 1024) throw new Error('too large');
    text = readFileSync(absolutePath, 'utf8');
  } catch {
    throw new Error('CONTRACTGUARD_POLICY_CONFIG must point to a readable JSON file no larger than 65536 bytes.');
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error('CONTRACTGUARD_POLICY_CONFIG is not valid JSON.');
  }
  return validateRulePolicy(value);
}
