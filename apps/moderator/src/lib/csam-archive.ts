/**
 * Where a filed CSAM report stands with the csam-archiver (a CronJob outside this repo). Read from
 * what the archiver already writes: `CsamReport.archivedAt`, stamped only after its verify passes,
 * and the user's `CsamArchive` JobQueue row.
 */
export type ArchiveState =
  | 'archived'
  | 'archiving'
  | 'failed'
  | 'queued'
  | 'not-archived'
  | 'unsent';

/** The archiver's `JobQueue.data` for one user (csam-archiver `src/queue/jobQueue.ts`). */
export type ArchiveJobData = {
  reportIds?: number[];
  claimedAt?: string;
  attempts?: number;
  lastError?: string;
};

/** The archiver's CLAIM_TTL_MINUTES default: an older claim belongs to a pod that died. */
export const ARCHIVE_CLAIM_TTL_MINUTES = 360;

export function archiveState(
  report: { id: number; reportSentAt: Date | string | null; archivedAt: Date | string | null },
  job: ArchiveJobData | null | undefined,
  now: Date = new Date()
): ArchiveState {
  if (report.archivedAt) return 'archived';
  if (job?.reportIds?.includes(report.id)) {
    const claimedAt = job.claimedAt ? new Date(job.claimedAt).getTime() : NaN;
    if (now.getTime() - claimedAt < ARCHIVE_CLAIM_TTL_MINUTES * 60_000) return 'archiving';
    return job.lastError ? 'failed' : 'queued';
  }
  return report.reportSentAt ? 'not-archived' : 'unsent';
}

/** Worst first: a user's row shows the state of the report that most needs a look. */
const SEVERITY: ArchiveState[] = [
  'failed',
  'not-archived',
  'queued',
  'archiving',
  'archived',
  'unsent',
];

export function worstArchiveState(states: ArchiveState[]): ArchiveState | null {
  if (!states.length) return null;
  return [...states].sort((a, b) => SEVERITY.indexOf(a) - SEVERITY.indexOf(b))[0];
}

export const ARCHIVE_STATE_LABEL: Record<ArchiveState, string> = {
  archived: 'Archived',
  archiving: 'Archiving',
  failed: 'Archive failed',
  queued: 'Archive queued',
  'not-archived': 'Not archived',
  unsent: 'Not sent',
};

export const ARCHIVE_STATE_VARIANT: Record<ArchiveState, 'secondary' | 'outline' | 'destructive'> =
  {
    archived: 'secondary',
    archiving: 'outline',
    failed: 'destructive',
    queued: 'outline',
    'not-archived': 'outline',
    unsent: 'outline',
  };
