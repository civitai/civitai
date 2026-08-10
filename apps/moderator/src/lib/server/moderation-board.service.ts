import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { getModeratorDb } from './moderator-db';
import { REPORT_SOURCES, CHAT_REPORT_SOURCE } from './report-sources';

// Retool's Moderation Status board — the parts that are NOT counts.
//
// The dashboard already carries every count this page had. What it never carried is the comparison the
// counts sat inside: who last worked each queue and when, and how far behind each swept task is. A
// number alone cannot distinguish a queue nobody has touched in a week from one being actively drained,
// which is the judgement the board existed to support.

/** Who last resolved a report of each type (Retool's `RecentReports`, a 12-way UNION of LIMIT 1s). */
export type QueueActivity = { type: string; at: Date; moderator: string | null };

export async function getRecentQueueActivity(): Promise<Map<string, QueueActivity>> {
  const sources = [...REPORT_SOURCES, CHAT_REPORT_SOURCE];

  // The join table is dynamic, so this is a raw `sql` tag rather than a builder join — the table name
  // comes from REPORT_SOURCES, never from a request. `!= 'Pending'` rather than `= 'Actioned'`:
  // unactioning is also working the queue, and Retool counted it. `statusSetAt` is null on rows that
  // predate the column.
  const rows = await Promise.all(
    sources.map(async ([label, , reportTable]) => {
      const { rows: found } = await sql<{ statusSetAt: Date; username: string | null }>`
        SELECT r."statusSetAt", u."username"
        FROM "Report" r
        JOIN ${sql.table(reportTable)} rt ON rt."reportId" = r."id"
        LEFT JOIN "User" u ON u."id" = r."statusSetBy"
        WHERE r."status" != 'Pending' AND r."statusSetAt" IS NOT NULL
        ORDER BY r."statusSetAt" DESC
        LIMIT 1
      `.execute(dbRead);

      const row = found[0];
      return row
        ? ([label, { type: label, at: row.statusSetAt, moderator: row.username }] as const)
        : null;
    })
  );

  return new Map(rows.filter((r): r is NonNullable<typeof r> => r !== null));
}

/**
 * How far behind each swept queue is (Retool's `MinorTimers`/`PoITimers`/`TagTimer`/… against
 * `Mods_TaskTimers`). Retool had one query per task; they differ only in the `task` literal.
 *
 * The row is an ACKNOWLEDGEMENT a moderator wrote, not a job run — see the table's type. So "3 days
 * ago" means nobody has claimed this queue in three days, which is the signal.
 */
export type TaskLag = { task: string; lastUpdate: Date; lastUpdateBy: string | null };

export async function getTaskLag(): Promise<TaskLag[]> {
  const rows = await getModeratorDb()
    .selectFrom('Mods_TaskTimers')
    .select((eb) => [
      'task',
      eb.fn.max('lastUpdate').as('lastUpdate'),
      // The name attached to the newest row, not an arbitrary one from the group.
      sql<string | null>`(array_agg("lastUpdateBy" ORDER BY "lastUpdate" DESC))[1]`.as(
        'lastUpdateBy'
      ),
    ])
    .where('task', 'is not', null)
    .groupBy('task')
    .execute();

  return rows
    .filter((r) => r.task && r.lastUpdate)
    .map((r) => ({
      task: r.task as string,
      lastUpdate: new Date(r.lastUpdate as unknown as string),
      lastUpdateBy: r.lastUpdateBy,
    }))
    .sort((a, b) => a.lastUpdate.getTime() - b.lastUpdate.getTime());
}

// SWEPT REVIEW COUNTS.
//
// Two queries the old audit filed as "backfill jobs" that are neither jobs nor backfills: each counts
// what has arrived in a queue SINCE the last acknowledgement, which is what makes them a workload
// rather than a total. Both read their bound from `Mods_TaskTimers`.
export const SWEEP_TASKS = ['blockedImages', 'civitaiModels'] as const;
export type SweepTask = (typeof SWEEP_TASKS)[number];

async function getSweepAt(task: SweepTask): Promise<Date | null> {
  const row = await getModeratorDb()
    .selectFrom('Mods_TaskTimers')
    .select('lastUpdate')
    .where('task', '=', task)
    .orderBy('lastUpdate', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.lastUpdate ? new Date(row.lastUpdate as unknown as string) : null;
}

/**
 * Retool's `BlockedImagesTask`: images blocked for an **unusual** reason since the last sweep. The four
 * excluded values are the ordinary ones — anything else means the blocker fired for a reason a
 * moderator has not seen, which is the case worth looking at.
 */
async function countBlockedImagesSince(since: Date): Promise<number> {
  const row = await dbRead
    .selectFrom('Image')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('ingestion', '=', 'Blocked')
    .where('blockedFor', 'not in', ['moderated', 'Moderated', 'CSAM', 'AiNotVerified'])
    .where('createdAt', '>', since)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

/** Retool's `CivitModelsData`: what the official account (`userId = -1`) has published since the sweep. */
async function countCivitaiModelsSince(since: Date): Promise<number> {
  const row = await dbRead
    .selectFrom('Model')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('userId', '=', -1)
    .where('status', '=', 'Published')
    .where('updatedAt', '>', since)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export type SweepCount = { task: SweepTask; since: Date | null; count: number };

export async function getSweepCounts(): Promise<SweepCount[]> {
  const [blockedAt, civitaiAt] = await Promise.all([
    getSweepAt('blockedImages'),
    getSweepAt('civitaiModels'),
  ]);

  // No acknowledgement yet means no bound, and an unbounded count over all history is a different
  // question — reported as "never swept" rather than as a number nobody can act on.
  const [blocked, civitai] = await Promise.all([
    blockedAt ? countBlockedImagesSince(blockedAt) : Promise.resolve(0),
    civitaiAt ? countCivitaiModelsSince(civitaiAt) : Promise.resolve(0),
  ]);

  return [
    { task: 'blockedImages', since: blockedAt, count: blocked },
    { task: 'civitaiModels', since: civitaiAt, count: civitai },
  ];
}

/**
 * The other half of the protocol. Retool wrote this from every `*Insert`/`*Check` button; without a
 * writer the mark never advances and every "since last sweep" count grows forever — the same
 * consumer-with-no-producer trap the help-request queue had.
 */
export async function acknowledgeSweep(task: string, by: string): Promise<void> {
  await getModeratorDb()
    .insertInto('Mods_TaskTimers')
    .values({ task, lastUpdate: sql`now()`, lastUpdateBy: by })
    .execute();
}

/**
 * Retool's `AutoBlockedUsers` (`table10` on the board): accounts the scam detector muted on its own.
 * Nobody decided these individually, so the list is the only place they are reviewable — and a false
 * positive here is a muted account with no moderator behind it.
 */
export type AutoBlockedUser = {
  id: number;
  userId: number;
  username: string | null;
  createdAt: Date;
  bannedAt: Date | null;
  muted: boolean | null;
};

/**
 * Retool's `ActionAllPostReports`: pending post reports whose post is *entirely* blocked already
 * (`nsfwLevel = 32` on every image). The content has resolved the report; the row is only still open
 * because nobody clicked it.
 *
 * `HAVING COUNT(*) = COUNT(CASE WHEN nsfwLevel = 32 …)` is doing real work — a post with one blocked
 * image and nine live ones must NOT match, so this cannot be rewritten as a simple `WHERE`. Posts with
 * no images cannot match either, since the join drops them.
 */
export async function getResolvedPostReportIds(limit = 500): Promise<number[]> {
  const { rows } = await sql<{ report_id: number }>`
    WITH targets AS (
      SELECT r.id AS report_id, i."nsfwLevel"
      FROM "Report" r
      JOIN "PostReport" pr ON pr."reportId" = r.id
      JOIN "Image" i ON i."postId" = pr."postId"
      WHERE r.status = 'Pending'
    )
    SELECT report_id
    FROM targets
    GROUP BY report_id
    HAVING COUNT(*) = COUNT(CASE WHEN "nsfwLevel" = 32 THEN 1 END)
    LIMIT ${limit}
  `.execute(dbRead);
  return rows.map((r) => r.report_id);
}

export async function getAutoBlockedUsers(limit = 50): Promise<AutoBlockedUser[]> {
  return (
    dbRead
      .selectFrom('ModActivity as ma')
      .innerJoin('User as u', 'u.id', 'ma.entityId')
      .select([
        'ma.id',
        'ma.entityId as userId',
        'ma.createdAt',
        'u.username',
        'u.bannedAt',
        'u.muted',
      ])
      .where('ma.activity', '=', 'autoMuteScam')
      // Retool had no entityType filter and got away with it because the activity name is unique to
      // users; keeping it makes the (entityType, entityId, createdAt) index usable.
      .where('ma.entityType', '=', 'user')
      .orderBy('ma.createdAt', 'desc')
      .limit(limit)
      .execute() as Promise<AutoBlockedUser[]>
  );
}
