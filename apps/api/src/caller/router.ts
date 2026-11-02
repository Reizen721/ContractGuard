import { randomUUID } from 'node:crypto';
import { Router, type ErrorRequestHandler } from 'express';
import { renderCallerReport } from '@contractguard/caller';
import { CallerReviewExecutor } from './executor.js';
import { CallerReviewStore } from './store.js';
import { CallerReviewError, type StoredCallerReview } from './types.js';

export function createCallerRouter(options: { dataDirectory: string; onExecutor?: (executor: CallerReviewExecutor) => void }): Router {
  const router = Router();
  const store = new CallerReviewStore(options.dataDirectory);
  const executor = new CallerReviewExecutor(); options.onExecutor?.(executor);
  router.post('/', async (request, response) => {
    const abort = new AbortController();
    const cancel = (): void => { if (!response.writableEnded) abort.abort(); };
    response.once('close', cancel);
    try {
      const report = await executor.run(request.body, abort.signal);
      if (abort.signal.aborted) return;
      const review: StoredCallerReview = { id: randomUUID(), createdAt: new Date().toISOString(), report };
      await store.save(review);
      response.status(201).json(review);
    } finally { response.removeListener('close', cancel); }
  });
  router.get('/', async (_request, response) => { response.json({ reviews: await store.list() }); });
  router.get('/:id', async (request, response) => {
    const review = await store.get(request.params.id);
    if (!review) throw new CallerReviewError(404, 'CALLER_REVIEW_NOT_FOUND', 'Caller review was not found.');
    response.json(review);
  });
  router.get('/:id/report', async (request, response) => {
    const format = request.query.format ?? 'json';
    if (format !== 'json' && format !== 'markdown') throw new CallerReviewError(400, 'CALLER_REPORT_FORMAT', 'format must be json or markdown.');
    const review = await store.get(request.params.id);
    if (!review) throw new CallerReviewError(404, 'CALLER_REVIEW_NOT_FOUND', 'Caller review was not found.');
    response.setHeader('Content-Disposition', `attachment; filename="contractguard-callers-${review.id}.${format === 'json' ? 'json' : 'md'}"`);
    if (format === 'json') response.json(review);
    else response.type('text/markdown').send(`# Saved caller review\n\nRecord: ${review.id}\n\nCreated: ${review.createdAt}\n\n${renderCallerReport(review.report, 'markdown')}`);
  });
  const errors: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (response.destroyed) return;
    if (error instanceof CallerReviewError) { response.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
    response.status(500).json({ error: { code: 'CALLER_INTERNAL_ERROR', message: 'Caller review request failed; internal details were not exposed.' } });
  };
  router.use(errors);
  return router;
}
