import { sql, type Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';

/**
 * Pays the gold of a closed yes/no question's votes once. A vote that matched the majority moves its gold from pending to earned;
 * any other vote drops it. The XP was paid at vote time and stays flat, and nothing here counts toward accuracy, fervor, rank or smites.
 * The caller has locked the voters' player rows in id order (as every settlement does).
 */
export async function settleYesNoVotes(trx: Transaction<DB>, itemId: number, now: Date) {
  const votes = await trx
    .selectFrom('KnightsVote')
    .select(['playerId', 'verdict', 'gold', 'createdAt'])
    .where('itemId', '=', itemId)
    .where('settledAt', 'is', null)
    .where('verdict', '<>', 'pending')
    .orderBy('playerId', 'asc')
    .forUpdate()
    .execute();
  if (votes.length === 0) return;

  const players = await trx
    .selectFrom('NewOrderPlayer')
    .select(['userId', 'startAt'])
    .where(
      'userId',
      'in',
      votes.map((v) => v.playerId)
    )
    .orderBy('userId', 'asc')
    .forUpdate()
    .execute();
  const startAt = new Map(players.map((p) => [p.userId, p.startAt]));

  for (const vote of votes) {
    // Gold from before a career reset was already forfeited with the reset.
    const reset = vote.createdAt < (startAt.get(vote.playerId) ?? new Date(0));
    const gold = vote.gold ?? 0;
    const paid = vote.verdict === 'matched' && !reset;
    await trx
      .updateTable('KnightsVote')
      .set({ gold: paid ? gold : 0, settledAt: utc(now) })
      .where('itemId', '=', itemId)
      .where('playerId', '=', vote.playerId)
      .execute();
    await trx
      .updateTable('NewOrderPlayer')
      .set({
        goldPending: sql<number>`GREATEST(0, "goldPending" - ${reset ? 0 : gold})`,
        goldEarned: sql<number>`"goldEarned" + ${paid ? gold : 0}`,
      })
      .where('userId', '=', vote.playerId)
      .execute();
  }
}
