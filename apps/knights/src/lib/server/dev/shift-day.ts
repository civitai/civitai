import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { addDays, dayStart } from '../daily/days';
import { ensureVotePartitions } from '../queue/queue.service';

export type ShiftDayResult = { ok: true } | { ok: false; reason: 'nothing-to-shift' };

/**
 * Dev only: makes the player's recorded days one UTC day older, so a solo tester can see the next-day
 * recap, streak growth or a shield cover a gap. Every day row moves, so earlier days stay one apart.
 */
export async function shiftMyDayBack(db: Kysely<DB>, userId: number): Promise<ShiftDayResult> {
  const earliest = await db
    .selectFrom('KnightsPlayerDay')
    .select(sql<string>`min("day")::text`.as('day'))
    .where('playerId', '=', userId)
    .executeTakeFirst();
  if (!earliest?.day) return { ok: false, reason: 'nothing-to-shift' };

  // Moving a vote across a month end needs the earlier month's partition to exist.
  await ensureVotePartitions(db, {
    now: new Date(dayStart(earliest.day).getTime() - 86_400_000),
    monthsAhead: 0,
  });

  await db.transaction().execute(async (trx) => {
    // Deleted, then re-inserted a day earlier: an in-place update would trip over the neighbouring row's key.
    const rows = await trx
      .deleteFrom('KnightsPlayerDay')
      .where('playerId', '=', userId)
      .returning([
        sql<string>`"day"::text`.as('day'),
        'votes',
        'goldRecorded',
        'watchCompletedAt',
        'bonusGold',
      ])
      .execute();
    await trx
      .insertInto('KnightsPlayerDay')
      .values(
        rows.map((row) => ({
          ...row,
          playerId: userId,
          day: sql<Date>`${addDays(row.day, -1)}::date`,
          watchCompletedAt:
            row.watchCompletedAt && new Date(row.watchCompletedAt.getTime() - 86_400_000),
        }))
      )
      .execute();
    await trx
      .updateTable('KnightsVote')
      .set({ createdAt: sql<Date>`"createdAt" - interval '1 day'` })
      .where('playerId', '=', userId)
      .where('createdAt', '>=', sql<Date>`${dayStart(earliest.day).toISOString()}::timestamp`)
      .execute();
    await trx
      .updateTable('KnightsPlayer')
      .set({
        lastWatchDay: sql<Date>`"lastWatchDay" - 1`,
        recapDismissedFor: sql<Date>`"recapDismissedFor" - 1`,
      })
      .where('playerId', '=', userId)
      .execute();
  });
  return { ok: true };
}
