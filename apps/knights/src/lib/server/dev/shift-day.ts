import { sql, type Kysely } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { addDays, dayStart, DAY_MS } from '../daily/days';
import { ensureVotePartitions } from '../queue/queue.service';

const SHIFT_DAYS = 1;

export type ShiftDayResult = { ok: true; days: number } | { ok: false; reason: 'nothing-to-shift' };

/** Dev only: moves all the player's day rows, votes and streak markers one UTC day earlier. */
export async function shiftMyDayBack(db: Kysely<DB>, userId: number): Promise<ShiftDayResult> {
  const earliest = await db
    .selectFrom('KnightsPlayerDay')
    .select(sql<string | null>`min("day")::text`.as('day'))
    .where('playerId', '=', userId)
    .executeTakeFirst();
  const earliestDay = earliest?.day;
  if (!earliestDay) return { ok: false, reason: 'nothing-to-shift' };

  // A partition cannot be created inside the transaction below; moving a vote across a month end needs the earlier month's.
  await ensureVotePartitions(db, {
    now: new Date(dayStart(earliestDay).getTime() - SHIFT_DAYS * DAY_MS),
    monthsAhead: 0,
  });

  return db.transaction().execute(async (trx): Promise<ShiftDayResult> => {
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
    if (rows.length === 0) return { ok: false, reason: 'nothing-to-shift' };

    await trx
      .insertInto('KnightsPlayerDay')
      .values(
        rows.map((row) => ({
          ...row,
          playerId: userId,
          day: sql<Date>`${addDays(row.day, -SHIFT_DAYS)}::date`,
          watchCompletedAt:
            row.watchCompletedAt &&
            utc(new Date(row.watchCompletedAt.getTime() - SHIFT_DAYS * DAY_MS)),
        }))
      )
      .execute();
    await trx
      .updateTable('KnightsVote')
      .set({ createdAt: sql<Date>`"createdAt" - make_interval(days => ${SHIFT_DAYS}::int)` })
      .where('playerId', '=', userId)
      .where('createdAt', '>=', utc(dayStart(earliestDay)))
      .execute();
    await trx
      .updateTable('KnightsPlayer')
      .set({
        lastWatchDay: sql<Date>`"lastWatchDay" - ${SHIFT_DAYS}::int`,
        recapDismissedFor: sql<Date>`"recapDismissedFor" - ${SHIFT_DAYS}::int`,
      })
      .where('playerId', '=', userId)
      .execute();
    return { ok: true, days: rows.length };
  });
}
