import express, { type RequestHandler, type Router } from 'express';
import {
  formatCegarReportMarkdown,
  getCegarLlmStatus,
  listCegarPresets,
  runCegarMigration,
  validateCegarRunRequest,
  type CegarLlmOptions,
} from './engine.js';
import { CegarRunStore } from './store.js';

export interface CegarRouterOptions extends CegarLlmOptions {
  dataDirectory: string;
}

function asyncRoute(
  fn: (req: express.Request, res: express.Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => void fn(req, res).catch(next);
}

function httpError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

export function createCegarRouter(options: CegarRouterOptions): Router {
  const router = express.Router();
  const store = new CegarRunStore(options.dataDirectory);

  router.get('/status', (_req, res) => {
    res.json({
      service: 'contractguard-cegar-agent',
      modes: ['symbolic', 'llm', 'hybrid'],
      gates: [
        'typescript-typechecker',
        'baseline-nominal-node-test',
        'outbound-request-contract',
        'differential-adversarial-witness-fuzzing',
      ],
      llm: getCegarLlmStatus(options),
    });
  });

  router.get('/presets', (_req, res) => {
    res.json({ presets: listCegarPresets() });
  });

  router.get(
    '/runs',
    asyncRoute(async (_req, res) => {
      res.json({ runs: await store.list() });
    }),
  );

  router.post(
    '/runs',
    asyncRoute(async (req, res) => {
      let body: unknown = req.body;
      if (body && typeof body === 'object' && !Array.isArray(body) && 'presetId' in body && body.presetId !== undefined) {
        const raw = body as Record<string, unknown>;
        if (['baseline', 'candidate', 'callerFiles', 'testFiles', 'probes', 'seedBaselineResponses'].some((k) => raw[k] !== undefined)) {
          throw httpError(400, 'CEGAR_PRESET_OVERRIDE_FORBIDDEN', 'presetId cannot be combined with explicit contract or workspace overrides.');
        }
        const preset = listCegarPresets().find((p) => p.id === raw.presetId);
        if (!preset) {
          throw httpError(404, 'CEGAR_PRESET_NOT_FOUND', `Unknown CEGAR preset: ${String(raw.presetId)}`);
        }
        body = {
          ...preset.request,
          ...(raw.title === undefined ? {} : { title: raw.title }),
          ...(raw.mode === undefined ? {} : { mode: raw.mode }),
          ...(raw.providerId === undefined ? {} : { providerId: raw.providerId }),
          ...(raw.maxRounds === undefined ? {} : { maxRounds: raw.maxRounds }),
          ...(raw.enableAdversarialFuzzing === undefined ? {} : { enableAdversarialFuzzing: raw.enableAdversarialFuzzing }),
        };
      }
      const validated = validateCegarRunRequest(body);
      const record = await runCegarMigration(validated, options);
      await store.save(record);
      res.status(201).json(record);
    }),
  );

  router.get(
    '/runs/:id',
    asyncRoute(async (req, res) => {
      const id = String(req.params.id ?? '');
      const record = await store.get(id);
      if (!record) throw httpError(404, 'CEGAR_RUN_NOT_FOUND', 'The requested CEGAR run record does not exist.');
      res.json(record);
    }),
  );

  router.get(
    '/runs/:id/report',
    asyncRoute(async (req, res) => {
      const id = String(req.params.id ?? '');
      const format = String(req.query.format ?? 'markdown');
      if (format !== 'json' && format !== 'markdown') {
        throw httpError(400, 'INVALID_REPORT_FORMAT', 'CEGAR report format must be json or markdown.');
      }
      const record = await store.get(id);
      if (!record) throw httpError(404, 'CEGAR_RUN_NOT_FOUND', 'The requested CEGAR run record does not exist.');
      if (format === 'json') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="contractguard-cegar-${record.id}.json"`);
        res.send(`${JSON.stringify(record, null, 2)}\n`);
        return;
      }
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="contractguard-cegar-${record.id}.md"`);
      res.send(formatCegarReportMarkdown(record));
    }),
  );

  return router;
}
