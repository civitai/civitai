import { sql } from '@civitai/db/kysely';
import { archiveState, type ArchiveJobData, type ArchiveState } from '$lib/csam-archive';
import {
  moderatorDbStatus,
  storeUnavailableMessage,
  type ModeratorDbStatus,
} from '$lib/moderator-db-status';
import type {
  ArchiveRunOutcome,
  ArchiveRunSummary,
  ArchiveRunVerify,
  CsamArchiveTables,
} from './csam-archive-tables';
import { dbRead } from './db';
import { getModeratorDb } from './moderator-db';

const runLog = () => getModeratorDb().withTables<CsamArchiveTables>();

export const runLogUnavailableMessage = (status: Exclude<ModeratorDbStatus, 'ok'>) =>
  storeUnavailableMessage(status, {
    tables: 'The CSAM archive run log',
    database: 'the moderator database',
    schemaFile: 'apps/moderator/csam-archive/schema.sql',
  });

/** Each user's `CsamArchive` queue row; a user with none is absent. */
export async function getArchiveJobs(userIds: number[]): Promise<Map<number, ArchiveJobData>> {
  if (!userIds.length) return new Map();
  const rows = await dbRead
    .selectFrom('JobQueue')
    .select(['entityId', 'data'])
    .where('type', '=', 'CsamArchive')
    .where('entityType', '=', 'User')
    .where('entityId', 'in', userIds)
    .execute();
  return new Map(rows.map((r) => [r.entityId, (r.data ?? {}) as ArchiveJobData]));
}

/** Counts only: the table holds nothing that names a file. */
export type ArchiveRun = {
  id: string;
  kind: 'report' | 'preservation';
  reportId: number | null;
  preservationId: string | null;
  userId: number;
  mode: 'dry-run' | 'write';
  scope: number[] | null;
  startedAt: Date;
  finishedAt: Date | null;
  outcome: ArchiveRunOutcome;
  summary: ArchiveRunSummary | null;
  verify: ArchiveRunVerify | null;
  archived: boolean;
  error: string | null;
  archiverVersion: string | null;
};

const runColumns = [
  'id',
  'kind',
  'report_id as reportId',
  'preservation_id as preservationId',
  'user_id as userId',
  'mode',
  'scope',
  'started_at as startedAt',
  'finished_at as finishedAt',
  'outcome',
  'summary',
  'verify',
  'archived',
  'error',
  'archiver_version as archiverVersion',
] as const;

type RunLogRead<T> = { status: 'ok'; value: T } | { status: Exclude<ModeratorDbStatus, 'ok'> };

async function readRunLog<T>(read: () => Promise<T>): Promise<RunLogRead<T>> {
  try {
    return { status: 'ok', value: await read() };
  } catch (e) {
    const status = moderatorDbStatus(e);
    if (status === 'unreachable') console.error('[csam-archive] run log read failed', e);
    return { status };
  }
}

/** The newest run of each report. The run log is a separate database, so its absence is a status, not a throw. */
export function getLatestRuns(reportIds: number[]): Promise<RunLogRead<Map<number, ArchiveRun>>> {
  return readRunLog(async () => {
    if (!reportIds.length) return new Map<number, ArchiveRun>();
    const rows = await runLog()
      .selectFrom('csam_archive_run')
      .select(runColumns)
      .distinctOn('report_id')
      .where('report_id', 'in', reportIds)
      .orderBy('report_id')
      .orderBy('started_at', 'desc')
      .execute();
    return new Map(rows.map((r) => [r.reportId as number, r as ArchiveRun]));
  });
}

export function listArchiveRuns({
  limit,
  offset,
  reportId,
}: {
  limit: number;
  offset: number;
  reportId?: number;
}): Promise<RunLogRead<{ items: ArchiveRun[]; hasMore: boolean }>> {
  return readRunLog(async () => {
    let q = runLog().selectFrom('csam_archive_run').select(runColumns);
    if (reportId !== undefined) q = q.where('report_id', '=', reportId);
    const rows = await q
      .orderBy('started_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .offset(offset)
      .execute();
    return { items: rows.slice(0, limit) as ArchiveRun[], hasMore: rows.length > limit };
  });
}

export type AwaitingArchive = {
  id: number;
  userId: number;
  username: string | null;
  reportSentAt: Date;
  state: ArchiveState;
  attempts: number;
  lastError: string | null;
};

/** Sent reports with no `archivedAt`, oldest first: the ones whose evidence is not yet locked away. */
export async function listAwaitingArchive(limit: number): Promise<{
  items: AwaitingArchive[];
  total: number;
}> {
  const base = dbRead
    .selectFrom('CsamReport')
    .where('reportSentAt', 'is not', null)
    .where('archivedAt', 'is', null)
    .where('userId', 'is not', null);
  const [rows, count] = await Promise.all([
    base
      .leftJoin('User', 'User.id', 'CsamReport.userId')
      .select([
        'CsamReport.id',
        'CsamReport.userId',
        'CsamReport.reportSentAt',
        'CsamReport.archivedAt',
        'User.username',
      ])
      .orderBy('CsamReport.reportSentAt', 'asc')
      .orderBy('CsamReport.id')
      .limit(limit)
      .execute(),
    base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
  ]);
  const jobs = await getArchiveJobs([...new Set(rows.map((r) => r.userId as number))]);
  return {
    total: Number(count.n),
    items: rows.map((r) => {
      const job = jobs.get(r.userId as number);
      return {
        id: r.id,
        userId: r.userId as number,
        username: r.username ?? null,
        reportSentAt: r.reportSentAt as Date,
        state: archiveState(r, job),
        attempts: job?.attempts ?? 0,
        lastError: job?.lastError ?? null,
      };
    }),
  };
}
