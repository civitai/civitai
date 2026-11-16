import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

/** The `JobQueue` type the evidence archiver works, one row per reported user. */
export const ARCHIVE_QUEUE_TYPE = 'CsamArchive';

/**
 * A report's place in the archiver's queue:
 * - `failing`: its row records an error or more than one claim, so a run has failed or died on it.
 * - `overdue`: its row is older than the queue's overdue window.
 * - `queued`: waiting for the archiver's next poll.
 */
export type ArchiveQueueState = 'queued' | 'failing' | 'overdue';

/**
 * SQL: the queue state of the report read as `report` (a table or alias with `id` and `userId`), or
 * null when no row lists it. A row lists a report the way the archiver's poll reads it: the row for
 * the report's user, an object `data` whose `reportIds` is an array holding the id as a JSON number.
 * A malformed row lists nothing, and the poll would not run it either.
 */
export function archiveQueueState(report: string, overdueMinutes: number) {
  const col = (name: string) => sql.ref(`${report}.${name}`);
  return sql<ArchiveQueueState | null>`(
    select case
      when q.data ->> 'lastError' is not null
        or (jsonb_typeof(q.data -> 'attempts') = 'number' and (q.data ->> 'attempts')::numeric > 1)
        then 'failing'
      when q."createdAt" < now() - make_interval(mins => ${overdueMinutes}) then 'overdue'
      else 'queued'
    end
    from "JobQueue" q
    where q.type = ${ARCHIVE_QUEUE_TYPE}
      and q."entityType" = 'User'
      and q."entityId" = ${col('userId')}
      and jsonb_typeof(q.data) = 'object'
      and jsonb_typeof(q.data -> 'reportIds') = 'array'
      and exists (
        select 1 from jsonb_array_elements(q.data -> 'reportIds') x
        where jsonb_typeof(x) = 'number' and x::text::numeric = ${col('id')}
      )
  )`;
}

/** The queue state of each listed report that is in the archiver's queue; absent ones are not. */
export async function archiveQueueStates(
  db: Kysely<DB>,
  reportIds: number[],
  overdueMinutes: number
): Promise<Map<number, ArchiveQueueState>> {
  if (!reportIds.length) return new Map();
  const { rows } = await sql<{ id: number; state: ArchiveQueueState | null }>`
    select r.id, ${archiveQueueState('r', overdueMinutes)} as state
    from "CsamReport" r
    where r.id = any(${reportIds}::int[])`.execute(db);
  return new Map(rows.flatMap((r) => (r.state ? [[r.id, r.state] as const] : [])));
}
