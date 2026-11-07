import { sql, type Kysely } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { dismissResetNotice } from '../smites/smites.service';

/**
 * A player's own career restart. Mirrors the main app's `resetPlayer` (`new-order.service.ts`): Acolyte, no XP,
 * unconverted gold forfeited, active smites cleansed, and `startAt` moved, which is what voids earlier votes and so their fervor. The shared `fervor` column is the original game's, so it is not written.
 * `startAt` comes from the database clock under the player row lock, the same ordering conversions rely on.
 */
export async function restartCareer(
  db: Kysely<DB>,
  playerId: number,
  now: Date
): Promise<{ reset: boolean }> {
  return db.transaction().execute(async (trx) => {
    const locked = await trx
      .selectFrom('NewOrderPlayer')
      .select('userId')
      .where('userId', '=', playerId)
      .forUpdate()
      .executeTakeFirst();
    if (!locked) return { reset: false };

    await trx
      .updateTable('NewOrderPlayer')
      .set({
        rankType: 'Acolyte',
        exp: 0,
        startAt: sql<Date>`clock_timestamp()`,
        goldPending: 0,
        goldEarned: sql<number>`"goldConverted"`,
      })
      .where('userId', '=', playerId)
      .execute();

    await trx
      .updateTable('NewOrderSmite')
      .set({ cleansedAt: utc(now), cleansedReason: 'Career restarted' })
      .where('targetPlayerId', '=', playerId)
      .where('cleansedAt', 'is', null)
      .execute();

    await dismissResetNotice(trx, playerId, now);
    return { reset: true };
  });
}
