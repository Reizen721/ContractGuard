import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertCallerReviewId, CallerReviewError, type CallerReviewSummary, type StoredCallerReview } from './types.js';

const MAX_RECORD_BYTES = 16 * 1024 * 1024;
export class CallerReviewStore {
  private readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }

  async save(review: StoredCallerReview): Promise<void> {
    assertCallerReviewId(review.id);
    const serialized = JSON.stringify(review);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) throw new CallerReviewError(413, 'CALLER_REPORT_TOO_LARGE', 'The complete caller report exceeds 16 MiB; reduce submitted source or scenarios. No report was saved.');
    await mkdir(this.directory, { recursive: true });
    const target = join(this.directory, `${review.id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }

  async get(id: string): Promise<StoredCallerReview | null> {
    assertCallerReviewId(id);
    const file = join(this.directory, `${id}.json`);
    try {
      if ((await stat(file)).size > MAX_RECORD_BYTES) throw new Error('Oversized record');
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (!isStoredReview(parsed) || parsed.id !== id) throw new Error('Invalid record');
      return parsed;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw new CallerReviewError(500, 'CALLER_RECORD_UNREADABLE', 'The saved caller review is unreadable. No internal file details were exposed.');
    }
  }

  async list(): Promise<CallerReviewSummary[]> {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory, { withFileTypes: true });
    const results: CallerReviewSummary[] = [];
    // Read sequentially: a large history must not load all source-containing reports at once.
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/i.test(entry.name)) continue;
      try {
        const review = await this.get(entry.name.slice(0, -5));
        if (!review) continue;
        const { id, createdAt, report } = review;
        const { toolVersion, evidenceKind, inputFingerprint, sourceFiles, summary, gate } = report;
        results.push({ id, createdAt, toolVersion, evidenceKind, inputFingerprint, sourceFiles, summary, gate });
      } catch { /* A damaged record cannot make unrelated history unreadable. */ }
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
}

function isStoredReview(value: unknown): value is StoredCallerReview {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<StoredCallerReview>;
  return typeof record.id === 'string' && typeof record.createdAt === 'string' && !!record.report
    && record.report.schemaVersion === 1 && record.report.evidenceKind === 'bounded-typescript-replay'
    && !!record.report.summary && Array.isArray(record.report.sourceFiles)
    && Array.isArray(record.report.callsites) && Array.isArray(record.report.checks) && Array.isArray(record.report.patches);
}
