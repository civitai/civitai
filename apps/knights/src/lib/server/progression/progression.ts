import { sql, type Kysely, type Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { PROGRESSION } from './config';

type Executor = Kysely<DB> | Transaction<DB>;

/** Same shape as the original game's fervor: correct votes x accuracy, with a floor on accuracy. */
export function calculateFervor({ correct, graded }: { correct: number; graded: number }): number {
  if (graded <= 0) return 0;
  const accuracy = Math.max(PROGRESSION.fervorAccuracyFloor, correct / graded);
  return Math.floor(correct * PROGRESSION.fervorPerCorrect * accuracy);
}

/** Inconclusive and still-pending votes are not in the window: they say nothing about accuracy. */
async function fervorOf(trx: Executor, playerId: number): Promise<number> {
  const window = await trx
    .selectFrom('KnightsVote')
    .select('verdict')
    .where('playerId', '=', playerId)
    .where('settledAt', 'is not', null)
    .where('verdict', 'in', ['correct', 'failed'])
    .orderBy('createdAt', 'desc')
    .limit(PROGRESSION.fervorWindow)
    .execute();
  return calculateFervor({
    correct: window.filter((v) => v.verdict === 'correct').length,
    graded: window.length,
  });
}

/**
 * Pays out the graded votes of one item, once. Only an item whose outcome can no longer change is
 * settled: a rating still waiting to be written to the image may yet be rerouted and its votes
 * regraded. Safe to call any number of times, from any path: the row lock plus `settledAt` mean a
 * vote is claimed by exactly one caller.
 */
export async function settleItemVotes(trx: Executor, itemId: number, now: Date): Promise<number> {
  const final = await trx
    .selectFrom('KnightsQueueItem')
    .select('id')
    .where('id', '=', itemId)
    .where((eb) =>
      eb.or([
        eb('status', '=', 'Closed'),
        eb.and([eb('status', '=', 'Resolved'), eb('appliedAt', 'is not', null)]),
      ])
    )
    .executeTakeFirst();
  if (!final) return 0;

  const votes = await trx
    .selectFrom('KnightsVote')
    .select(['playerId', 'verdict', 'gold'])
    .where('itemId', '=', itemId)
    .where('settledAt', 'is', null)
    .where('verdict', '<>', 'pending')
    .forUpdate()
    .execute();
  if (votes.length === 0) return 0;

  const perPlayer = new Map<number, { xp: number; pending: number; earned: number }>();
  for (const vote of votes) {
    const correct = vote.verdict === 'correct';
    const gold = vote.gold ?? 0;
    const bulk = correct ? PROGRESSION.correctXp : 0;
    await trx
      .updateTable('KnightsVote')
      .set({
        xp: sql<number>`"xp" + ${bulk}`,
        gold: correct ? gold : 0,
        settledAt: utc(now),
      })
      .where('itemId', '=', itemId)
      .where('playerId', '=', vote.playerId)
      .execute();

    const total = perPlayer.get(vote.playerId) ?? { xp: 0, pending: 0, earned: 0 };
    total.xp += bulk;
    total.pending += gold;
    total.earned += correct ? gold : 0;
    perPlayer.set(vote.playerId, total);
  }

  for (const [playerId, total] of perPlayer) {
    await trx
      .updateTable('NewOrderPlayer')
      .set({
        exp: sql<number>`"exp" + ${total.xp}`,
        goldPending: sql<number>`GREATEST(0, "goldPending" - ${total.pending})`,
        goldEarned: sql<number>`"goldEarned" + ${total.earned}`,
        fervor: await fervorOf(trx, playerId),
      })
      .where('userId', '=', playerId)
      .execute();
  }
  return votes.length;
}

/**
 * Catches items settled by a path that does not call `settleItemVotes` (the moderator app's
 * rulings) or that crashed before it ran. Run from the tick job.
 */
export async function settleFinalItems(
  db: Kysely<DB>,
  { now, limit = 200 }: { now: Date; limit?: number }
): Promise<{ items: number; votes: number }> {
  const due = await db
    .selectFrom('KnightsVote as v')
    .innerJoin('KnightsQueueItem as i', 'i.id', 'v.itemId')
    .select('v.itemId')
    .distinct()
    .where('v.settledAt', 'is', null)
    .where('v.verdict', '<>', 'pending')
    .where((eb) =>
      eb.or([
        eb('i.status', '=', 'Closed'),
        eb.and([eb('i.status', '=', 'Resolved'), eb('i.appliedAt', 'is not', null)]),
      ])
    )
    .limit(limit)
    .execute();

  let votes = 0;
  for (const { itemId } of due) {
    votes += await db.transaction().execute((trx) => settleItemVotes(trx, itemId, now));
  }
  return { items: due.length, votes };
}
