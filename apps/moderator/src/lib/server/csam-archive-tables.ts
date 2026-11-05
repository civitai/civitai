import type { Generated, Timestamp } from './moderator-db/types';

export type ArchiveRunOutcome = 'running' | 'collected' | 'verified' | 'failed' | 'error';

export type ArchiveRunSummary = {
  ok: number;
  planned: number;
  failed: number;
  external: number;
  total: number;
  skipped: number;
  byItem: Record<string, { entries: number; bytes: number; rows: number }>;
};

export type ArchiveRunVerify = {
  ok: boolean;
  expected: number;
  found: number;
  mismatches: number;
  failedEntries: number;
};

/** Hand-declared: the table is hand-applied (`apps/moderator/csam-archive/schema.sql`), not pulled. */
export type CsamArchiveTables = {
  csam_archive_run: {
    id: Generated<string>;
    kind: 'report' | 'preservation';
    report_id: number | null;
    preservation_id: string | null;
    user_id: number;
    mode: 'dry-run' | 'write';
    scope: number[] | null;
    started_at: Generated<Timestamp>;
    finished_at: Timestamp | null;
    outcome: Generated<ArchiveRunOutcome>;
    summary: ArchiveRunSummary | null;
    verify: ArchiveRunVerify | null;
    archived: Generated<boolean>;
    error: string | null;
    archiver_version: string | null;
  };
};
