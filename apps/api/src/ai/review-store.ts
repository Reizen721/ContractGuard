import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseAndValidateGeneratedReview } from './review-schema.js';
import type { AiReview, AiReviewCoverage } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;

interface SavedReview {
  cacheKey: string;
  storedAt: number;
  review: AiReview;
}

/** Reports live outside the flat analysis directory, so old history readers stay compatible. */
export class AiReviewStore {
  private readonly directory: string;
  private lastStoredAt = 0;

  constructor(dataDirectory: string) {
    this.directory = resolve(dataDirectory, 'ai-reviews');
  }

  async save(analysisId: string, cacheKey: string, review: AiReview): Promise<AiReview> {
    const directory = this.analysisDirectory(analysisId);
    if (!HASH.test(cacheKey)) throw new Error('Invalid AI review cache key.');
    const saved: AiReview = { ...review, id: randomUUID(), analysisId };
    this.lastStoredAt = Math.max(Date.now(), this.lastStoredAt + 1);
    const record: SavedReview = { cacheKey, storedAt: this.lastStoredAt, review: saved };
    await mkdir(directory, { recursive: true });
    const target = join(directory, `${saved.id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    return saved;
  }

  async list(analysisId: string): Promise<AiReview[]> {
    return (await this.records(analysisId)).map((record) => record.review);
  }

  async find(analysisId: string, cacheKey: string): Promise<AiReview | undefined> {
    return (await this.records(analysisId)).find((record) => record.cacheKey === cacheKey)?.review;
  }

  async get(analysisId: string, reviewId: string): Promise<AiReview | undefined> {
    assertUuid(reviewId);
    return (await this.records(analysisId)).find((record) => record.review.id === reviewId)?.review;
  }

  async deleteForAnalysis(analysisId: string): Promise<void> {
    // Both path components are fixed or validated UUIDs, never user-supplied paths.
    await rm(this.analysisDirectory(analysisId), { recursive: true, force: true });
  }

  async deleteReview(analysisId: string, reviewId: string): Promise<void> {
    assertUuid(reviewId);
    await rm(join(this.analysisDirectory(analysisId), `${reviewId}.json`), { force: true });
  }

  private analysisDirectory(id: string): string {
    assertUuid(id);
    return join(this.directory, id);
  }

  private async records(analysisId: string): Promise<SavedReview[]> {
    const directory = this.analysisDirectory(analysisId);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const records = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && UUID.test(entry.name.slice(0, -5)))
      .map(async (entry): Promise<SavedReview | null> => {
        try {
          const file = join(directory, entry.name);
          if ((await stat(file)).size > MAX_RECORD_BYTES) return null;
          const text = await readFile(file, 'utf8');
          if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) return null;
          return validateRecord(JSON.parse(text), analysisId, entry.name.slice(0, -5));
        } catch {
          // One corrupt/legacy record must not make the complete history unusable.
          return null;
        }
      }));
    return records.filter((record): record is SavedReview => record !== null)
      .sort((left, right) => right.storedAt - left.storedAt || String(right.review.id).localeCompare(String(left.review.id)));
  }
}

function validateRecord(value: unknown, analysisId: string, reviewId: string): SavedReview | null {
  if (!isRecord(value) || !HASH.test(String(value.cacheKey)) || !Number.isSafeInteger(value.storedAt)) return null;
  const review = value.review;
  if (!isRecord(review) || review.id !== reviewId || review.analysisId !== analysisId || review.schemaVersion !== '1.0') return null;
  if (review.language !== 'zh-CN' && review.language !== 'en') return null;
  if (review.promptVersion !== 'ai-explainer-v1' && review.promptVersion !== 'ai-explainer-v2'
    && review.promptVersion !== 'ai-explainer-v3' && review.promptVersion !== 'ai-explainer-v4') return null;
  if (!text(review.generatedAt, 100) || !Number.isFinite(Date.parse(review.generatedAt))) return null;
  if (![review.provider, review.providerId, review.providerLabel, review.model].every((item) => text(item, 200))) return null;
  if (review.focus !== undefined && (typeof review.focus !== 'string' || review.focus.length > 500)) return null;
  const coverage = validateCoverage(review.coverage);
  if (!coverage) return null;
  const generated = parseAndValidateGeneratedReview(JSON.stringify({
    overview: review.overview,
    keyRisks: review.keyRisks,
    migrationPlan: review.migrationPlan,
    testSuggestions: review.testSuggestions,
    caveats: review.caveats,
  }), new Set(coverage.includedChangeIds), String(review.providerLabel));
  // Keep the bounded server-added coverage/conflict caveats as well as model caveats.
  if (!Array.isArray(review.caveats) || review.caveats.length > 9 || !review.caveats.every((item) => text(item, 500))) return null;
  let usage: AiReview['usage'];
  if (review.usage !== undefined) {
    if (!isRecord(review.usage)) return null;
    usage = {};
    for (const key of ['promptTokens', 'completionTokens', 'totalTokens'] as const) {
      const count = review.usage[key];
      if (count !== undefined) {
        if (!Number.isSafeInteger(count) || (count as number) < 0) return null;
        usage[key] = count as number;
      }
    }
  }
  return {
    cacheKey: value.cacheKey as string,
    storedAt: value.storedAt as number,
    review: {
      id: reviewId,
      schemaVersion: '1.0',
      analysisId,
      language: review.language,
      ...(review.focus === undefined ? {} : { focus: review.focus as string }),
      provider: review.provider as string,
      providerId: review.providerId as string,
      providerLabel: review.providerLabel as string,
      model: review.model as string,
      generatedAt: review.generatedAt,
      promptVersion: review.promptVersion,
      ...generated,
      caveats: review.caveats as string[],
      coverage,
      ...(usage === undefined ? {} : { usage }),
    },
  };
}

function validateCoverage(value: unknown): AiReviewCoverage | undefined {
  if (!isRecord(value)) return undefined;
  const { totalFindings, includedFindings, omittedFindings, includedChangeIds } = value;
  if (![totalFindings, includedFindings, omittedFindings].every((count) => Number.isSafeInteger(count) && (count as number) >= 0)) return undefined;
  if (!Array.isArray(includedChangeIds) || includedChangeIds.length > 200 || includedChangeIds.length !== includedFindings) return undefined;
  if (!includedChangeIds.every((id) => text(id, 100)) || new Set(includedChangeIds).size !== includedChangeIds.length) return undefined;
  if ((includedFindings as number) + (omittedFindings as number) !== totalFindings) return undefined;
  return { totalFindings, includedFindings, omittedFindings, includedChangeIds } as AiReviewCoverage;
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw Object.assign(new Error('Invalid AI review identifier.'), { status: 400, code: 'INVALID_AI_REVIEW_ID' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
