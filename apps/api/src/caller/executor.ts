import { Worker } from 'node:worker_threads';
import type { CallerImpactReport } from '@contractguard/caller';
import { CallerReviewError } from './types.js';

// This is fixed application code. Submitted TypeScript is only AST data for the
// bounded interpreter; never interpolated into this worker or executed by Node.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.moduleUrl).then(({ analyzeCallerImpact }) => {
  try { parentPort.postMessage({ ok: true, report: analyzeCallerImpact(workerData.input) }); }
  catch (error) { parentPort.postMessage({ ok: false, error: { code: error?.code, name: error?.name, message: error?.message } }); }
}).catch(() => parentPort.postMessage({ ok: false, error: { code: 'CALLER_ENGINE_UNAVAILABLE' } }));
`;

export class CallerReviewExecutor {
  private readonly workers = new Map<Worker, () => void>();
  private closed = false;
  constructor(private readonly timeoutMs = 15_000, private readonly maxConcurrent = 2) {}

  async run(input: unknown, signal: AbortSignal): Promise<CallerImpactReport> {
    if (this.closed) throw new CallerReviewError(503, 'CALLER_SERVICE_CLOSED', 'Caller review service is shutting down.');
    if (signal.aborted) throw new CallerReviewError(499, 'CALLER_REVIEW_CANCELLED', 'Caller review was cancelled before execution.');
    if (this.workers.size >= this.maxConcurrent) throw new CallerReviewError(429, 'CALLER_SERVICE_BUSY', 'The local caller review worker limit is reached. Retry after another review finishes.');
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_SOURCE, {
        eval: true, workerData: { moduleUrl: import.meta.resolve('@contractguard/caller'), input },
        resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
        env: {}, stdout: true, stderr: true,
      });
      // No submitted data or engine diagnostics are forwarded to service logs.
      worker.stdout?.resume(); worker.stderr?.resume();
      let settled = false;
      const finish = (error?: CallerReviewError, report?: CallerImpactReport): void => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
        void worker.terminate().then(() => this.workers.delete(worker), () => this.workers.delete(worker));
        if (error) reject(error); else resolve(report!);
      };
      const cancel = (): void => finish(new CallerReviewError(499, 'CALLER_REVIEW_CANCELLED', 'Caller review was cancelled. No successful report was saved.'));
      const timer = setTimeout(() => finish(new CallerReviewError(504, 'CALLER_REVIEW_TIMEOUT', `Caller review exceeded its ${this.timeoutMs} ms execution limit. No successful report was saved.`)), this.timeoutMs);
      this.workers.set(worker, cancel);
      signal.addEventListener('abort', cancel, { once: true });
      worker.once('message', (message: { ok?: boolean; report?: CallerImpactReport; error?: { code?: string; name?: string; message?: string } }) => {
        if (message.ok && message.report) { finish(undefined, message.report); return; }
        const error = message.error;
        if (error?.code === 'INVALID_CALLER_INPUT' || error?.name === 'ContractGuardError') {
          finish(new CallerReviewError(400, error.code && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'INVALID_CALLER_INPUT', typeof error.message === 'string' ? error.message.slice(0, 1000) : 'Invalid caller review input.'));
        } else finish(new CallerReviewError(500, 'CALLER_ENGINE_ERROR', 'Caller review could not complete. Internal details were not exposed.'));
      });
      worker.once('error', () => finish(new CallerReviewError(500, 'CALLER_ENGINE_ERROR', 'Caller review worker failed. No successful report was saved.')));
      worker.once('exit', () => { if (!settled) finish(new CallerReviewError(500, 'CALLER_ENGINE_ERROR', 'Caller review worker stopped before producing a report.')); });
      if (signal.aborted) cancel();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const workers = [...this.workers];
    for (const [, cancel] of workers) cancel();
    await Promise.all(workers.map(([worker]) => worker.terminate()));
    this.workers.clear();
  }
}
