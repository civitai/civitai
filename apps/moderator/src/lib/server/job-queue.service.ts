import { sql } from '@civitai/db/kysely';
import { JOB_QUEUE_OVERDUE_MINUTES } from '@civitai/shared/job-queue';
import type { EntityType, JobQueueType } from '@civitai/db-schema/enums';
import { dbRead } from './db';

export type JobQueueLane = {
  type: JobQueueType;
  entityType: EntityType;
  depth: number;
  overdue: number;
  oldestAt: Date | null;
};

export type JobQueueHealth = {
  lanes: JobQueueLane[];
  depth: number;
  overdue: number;
};

/**
 * Per-row cutoff, built from `JOB_QUEUE_OVERDUE_MINUTES` rather than written in SQL, so the threshold
 * a moderator sees and the one the draining cron honours come from the same table.
 *
 * A type missing from the CASE yields NULL, and `"createdAt" < NULL` is NULL — so it counts as not
 * overdue. That is the safe direction: a new enum value under-reports until someone gives it a
 * figure, rather than showing every row of it as stranded.
 *
 * 🔴 `::timestamptz` on every branch is load-bearing, and `::timestamp` is NOT a valid substitute even
 * though the column is `timestamp without time zone`. Every THEN is a bind parameter, so with no cast
 * Postgres resolves the CASE to `text` and the statement fails to PLAN — and `pg` serialises a Date as
 * local wall-clock digits plus an offset, which `::timestamp` discards, shifting every cutoff by the
 * client's offset. Compiling the SQL proves neither: both are resolved by the server.
 */
function overdueWhere(now: number) {
  const branches = Object.entries(JOB_QUEUE_OVERDUE_MINUTES).map(
    ([type, minutes]) => sql`WHEN ${type} THEN ${new Date(now - minutes * 60_000)}::timestamptz`
  );
  return sql<boolean>`"createdAt" < CASE type::text ${sql.join(branches, sql` `)} END`;
}

/** 🔴 `depth` is not a health signal and must never be surfaced as one — see JOB_QUEUE_OVERDUE_MINUTES. */
export async function getJobQueueHealth(): Promise<JobQueueHealth> {
  const rows = await dbRead
    .selectFrom('JobQueue')
    .select((eb) => [
      'type',
      'entityType',
      eb.fn.countAll<string>().as('depth'),
      eb.fn.countAll<string>().filterWhere(overdueWhere(Date.now())).as('overdue'),
      eb.fn.min('createdAt').as('oldest'),
    ])
    .groupBy(['type', 'entityType'])
    .execute();

  const lanes = rows
    .map((row) => ({
      type: row.type,
      entityType: row.entityType,
      depth: Number(row.depth),
      overdue: Number(row.overdue),
      oldestAt: row.oldest ?? null,
    }))
    .sort((a, b) => b.overdue - a.overdue || b.depth - a.depth);

  return {
    lanes,
    depth: lanes.reduce((total, lane) => total + lane.depth, 0),
    overdue: lanes.reduce((total, lane) => total + lane.overdue, 0),
  };
}
