import { createHash } from 'node:crypto';
import type { StoredAnalysis } from '../types.js';
import { AI_PROMPT_VERSION } from './prompt.js';
import { AiReviewStore } from './review-store.js';
import { AiServiceError, type AiReview, type AiReviewRequest, type AiReviewService } from './types.js';

interface PendingReview {
  analysisId: string;
  controller: AbortController;
  subscribers: number;
  settled: boolean;
  promise: Promise<AiReview>;
}

/** Per-process single-flight plus per-analysis durable results. No provider fallback. */
export class AiReviewCoordinator {
  private readonly pending = new Map<string, PendingReview>();
  private readonly deleted = new Set<string>();

  constructor(private readonly service: AiReviewService, private readonly store: AiReviewStore) {}

  async review(analysis: StoredAnalysis, input: AiReviewRequest, signal?: AbortSignal): Promise<AiReview> {
    if (signal?.aborted) throw cancelled();
    if (this.deleted.has(analysis.id)) throw cancelled();
    const request: AiReviewRequest = {
      language: input.language,
      ...(input.focus === undefined ? {} : { focus: input.focus }),
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
    };
    // Validation is performed before any lookup: a disabled provider cannot be used via old cache.
    const identity = this.service.cacheIdentity?.(request) ?? this.customServiceIdentity(request);
    const key = createHash('sha256').update(JSON.stringify({
      analysisId: analysis.id,
      engineVersion: analysis.engineVersion,
      source: analysis.source,
      policy: analysis.policy,
      findings: analysis.changes,
      score: analysis.score,
      compatible: analysis.compatible,
      analysisCoverage: analysis.coverage,
      consumerImpact: analysis.consumerImpact,
      identity,
      promptVersion: AI_PROMPT_VERSION,
      language: request.language,
      focus: request.focus ?? '',
    })).digest('hex');
    if (!input.force) {
      const saved = await this.store.find(analysis.id, key);
      if (signal?.aborted || this.deleted.has(analysis.id)) throw cancelled();
      if (saved) return saved;
    }
    let job = this.pending.get(key);
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController();
      const created: PendingReview = {
        analysisId: analysis.id, controller, subscribers: 0, settled: false,
        promise: Promise.resolve(undefined as unknown as AiReview),
      };
      created.promise = Promise.resolve().then(async () => {
        if (controller.signal.aborted) throw cancelled();
        const generated = await this.service.review(analysis, request, { signal: controller.signal });
        if (controller.signal.aborted || this.deleted.has(analysis.id)) throw cancelled();
        const saved = await this.store.save(analysis.id, key, generated);
        // A delete can race the atomic write. Clean up after it rather than reviving orphan reports.
        if (controller.signal.aborted || this.deleted.has(analysis.id)) {
          if (this.deleted.has(analysis.id)) await this.store.deleteForAnalysis(analysis.id);
          else if (saved.id) await this.store.deleteReview(analysis.id, saved.id);
          throw cancelled();
        }
        return saved;
      }).finally(() => {
        created.settled = true;
        if (this.pending.get(key) === created) this.pending.delete(key);
      });
      this.pending.set(key, created);
      job = created;
    }
    return subscribe(job, signal);
  }

  async discardAnalysis(analysisId: string): Promise<void> {
    this.deleted.add(analysisId);
    for (const job of this.pending.values()) if (job.analysisId === analysisId) job.controller.abort();
    await this.store.deleteForAnalysis(analysisId);
  }

  private customServiceIdentity(request: AiReviewRequest): string {
    const status = this.service.status();
    if (!status.enabled) throw new AiServiceError(503, 'AI_DISABLED', 'AI review is disabled on this server.');
    const id = request.providerId ?? status.activeProviderId;
    if (id !== status.activeProviderId && !status.allowRequestProviderOverride) {
      throw new AiServiceError(400, 'AI_PROVIDER_OVERRIDE_DISABLED', 'Selecting a different AI provider is disabled on this server.');
    }
    const profile = status.providers.find((provider) => provider.id === id);
    if (!profile) throw new AiServiceError(400, 'AI_PROVIDER_NOT_FOUND', 'The requested AI provider is not configured on this server.');
    if (!profile.available) throw new AiServiceError(503, 'AI_NOT_CONFIGURED', 'The selected AI provider is not available.');
    return JSON.stringify({ profile, promptVersion: status.promptVersion });
  }
}

function subscribe(job: PendingReview, signal?: AbortSignal): Promise<AiReview> {
  job.subscribers += 1;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: unknown, value?: AiReview): void => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', abort);
      job.subscribers -= 1;
      if (job.subscribers === 0 && !job.settled) job.controller.abort();
      if (error !== undefined) reject(error);
      else resolve(value!);
    };
    const abort = (): void => finish(cancelled());
    job.promise.then((value) => finish(undefined, value), (error) => finish(error));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function cancelled(): AiServiceError {
  return new AiServiceError(499, 'AI_REQUEST_CANCELLED', 'The AI review request was cancelled.');
}
