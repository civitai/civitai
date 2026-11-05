import { sql, type Kysely, type SqlBool, type Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { PROGRESSION } from '../progression/config';
import { APPRENTICE } from './config';

type Executor = Kysely<DB> | Transaction<DB>;

/** The Acolyte levels a rise from `before` to `after` gains: 2 up to the knight level, no more. */
export function acolyteLevelsGained(before: number, after: number): number[] {
  const levels: number[] = [];
  for (
    let level = Math.max(before + 1, 2);
    level <= Math.min(after, APPRENTICE.knightLevel);
    level++
  ) {
    levels.push(level);
  }
  return levels;
}

/**
 * Pays gold for each Acolyte level the rise gains that was never paid to this player, and returns the gold paid. The
 * (player, level) key makes it once per level for good: a career restart keeps the rows, so re-levelling pays nothing.
 * Run it in the transaction that moves the XP.
 */
export async function grantAcolyteLevelGold(
  trx: Transaction<DB>,
  input: { playerId: number; before: number; after: number; now: Date }
): Promise<number> {
  const levels = acolyteLevelsGained(input.before, input.after);
  if (levels.length === 0) return 0;
  const gold = PROGRESSION.acolyteLevelGold;
  const paid = await trx
    .insertInto('KnightsAcolyteLevelGold')
    .values(
      levels.map((level) => ({ playerId: input.playerId, level, gold, createdAt: utc(input.now) }))
    )
    .onConflict((conflict) => conflict.columns(['playerId', 'level']).doNothing())
    .returning('gold')
    .execute();
  const total = paid.reduce((sum, row) => sum + row.gold, 0);
  if (total > 0) {
    await trx
      .updateTable('NewOrderPlayer')
      .set({ goldEarned: sql<number>`"goldEarned" + ${total}` })
      .where('userId', '=', input.playerId)
      .execute();
  }
  return total;
}

/** Gold paid for levels in (from, to] since the player's current career began, for the level-up notice. */
export async function acolyteLevelGoldSince(
  db: Executor,
  playerId: number,
  from: number,
  to: number
): Promise<number> {
  const row = await db
    .selectFrom('KnightsAcolyteLevelGold as g')
    .select(sql<string | null>`sum(g."gold")`.as('gold'))
    .where('g.playerId', '=', playerId)
    .where('g.level', '>', from)
    .where('g.level', '<=', to)
    .where(
      sql<SqlBool>`g."createdAt" >= COALESCE((SELECT "startAt" FROM "NewOrderPlayer" WHERE "userId" = g."playerId"), 'epoch')`
    )
    .executeTakeFirst();
  return Number(row?.gold ?? 0);
}
