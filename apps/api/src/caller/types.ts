import type { CallerImpactReport } from '@contractguard/caller';

export interface StoredCallerReview { id: string; createdAt: string; report: CallerImpactReport }
export type CallerReviewSummary = Pick<StoredCallerReview, 'id' | 'createdAt'> &
  Pick<CallerImpactReport, 'toolVersion' | 'evidenceKind' | 'inputFingerprint' | 'sourceFiles' | 'summary' | 'gate'>;

export class CallerReviewError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'CallerReviewError'; }
}
export function assertCallerReviewId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new CallerReviewError(400, 'INVALID_CALLER_REVIEW_ID', 'A caller review identifier must be a UUID.');
  }
}
