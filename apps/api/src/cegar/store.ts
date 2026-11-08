import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CegarRunRecord } from './types.js';

const UUID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_STORED_RUNS = 200;

export interface CegarRunSummary {
  id: string;
  title: string;
  createdAt: string;
  mode: CegarRunRecord['mode'];
  releaseGate: CegarRunRecord['releaseGate'];
  callerImpactStatus: CegarRunRecord['callerImpactStatus'];
  patchStatus: CegarRunRecord['patchStatus'];
  rounds: number;
  adversarialCount: number;
  durationMs: number;
}

export class CegarRunStore {
  private readonly directory: string;

  constructor(dataDirectory: string) {
    this.directory = resolve(dataDirectory);
  }

  async save(record: CegarRunRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const destination = join(this.directory, `${record.id}.json`);
    const temporary = join(this.directory, `.${record.id}.${Date.now()}.tmp`);
    await writeFile(temporary, JSON.stringify(record, null, 2), 'utf8');
    await rename(temporary, destination);
    await this.prune();
  }

  async get(id: string): Promise<CegarRunRecord | undefined> {
    if (!UUID_PATTERN.test(id)) return undefined;
    try {
      const raw = await readFile(join(this.directory, `${id}.json`), 'utf8');
      return JSON.parse(raw) as CegarRunRecord;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<CegarRunSummary[]> {
    try {
      const files = (await readdir(this.directory)).filter((name) => name.endsWith('.json'));
      const records: CegarRunSummary[] = [];
      for (const file of files) {
        try {
          const parsed = JSON.parse(await readFile(join(this.directory, file), 'utf8')) as CegarRunRecord;
          if (parsed && parsed.schemaVersion === 1 && typeof parsed.id === 'string') {
            records.push({
              id: parsed.id,
              title: parsed.title,
              createdAt: parsed.createdAt,
              mode: parsed.mode,
              releaseGate: parsed.releaseGate,
              callerImpactStatus: parsed.callerImpactStatus,
              patchStatus: parsed.patchStatus,
              rounds: parsed.rounds.length,
              adversarialCount: parsed.witnesses.adversarialCount,
              durationMs: parsed.durationMs,
            });
          }
        } catch {
          // ignore corrupted files
        }
      }
      records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return records;
    } catch {
      return [];
    }
  }

  private async prune(): Promise<void> {
    const items = await this.list();
    if (items.length <= MAX_STORED_RUNS) return;
    for (const stale of items.slice(MAX_STORED_RUNS)) {
      try {
        await unlink(join(this.directory, `${stale.id}.json`));
      } catch {
        // already removed
      }
    }
  }
}
