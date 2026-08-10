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
