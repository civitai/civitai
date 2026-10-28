import { sql, type Kysely, type SqlBool, type Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { getLevelProgression } from '@civitai/shared/new-order-levels';
import { finalItem } from '../queue/item-state';
import { PROGRESSION } from './config';
import { accuracyOf, earnedRank, type Ledger } from './rating';
import { mirrorXp, type XpDelta, type XpMirror } from './legacy-exp';

type Executor = Kysely<DB> | Transaction<DB>;
type RankType = DB['NewOrderPlayer']['rankType'];

/** Accuracy is floored so a poor streak does not zero fervor. */
export function calculateFervor({ correct, graded }: { correct: number; graded: number }): number {
  if (graded <= 0) return 0;
  const accuracy = Math.max(PROGRESSION.fervorAccuracyFloor, correct / graded);
  return Math.floor(correct * PROGRESSION.fervorPerCorrect * accuracy);
}

/** The player's last `fervorWindow` graded votes, one scan for fervor and accuracy. Inconclusive and still-pending votes are not in it, nor are votes cast before the career reset. */
export async function ledgerOf(db: Executor, playerId: number): Promise<Ledger> {
  const window = db
    .selectFrom('KnightsVote as v')
    .select('v.verdict')
    .where('v.playerId', '=', playerId)
    .where('v.settledAt', 'is not', null)
    .where('v.verdict', 'in', ['correct', 'failed'])
    .where(
      sql<SqlBool>`v."createdAt" >= COALESCE((SELECT "startAt" FROM "NewOrderPlayer" WHERE "userId" = v."playerId"), 'epoch')`
    )
    .orderBy('v.createdAt', 'desc')
    .limit(PROGRESSION.fervorWindow)
    .as('w');
  const totals = await db
    .selectFrom(window)
    .select([
      sql<string>`count(*)`.as('graded'),
      sql<string>`count(*) filter (where w.verdict = 'correct')`.as('correct'),
    ])
    .executeTakeFirstOrThrow();
  return { correct: Number(totals.correct), graded: Number(totals.graded) };
}

export const fervorOf = async (db: Executor, playerId: number): Promise<number> =>
  calculateFervor(await ledgerOf(db, playerId));

/** Moves a Knight, Templar or Paladin up to the highest rank their level and accuracy earn; never down, and the guard keeps a concurrent change of rank from being overwritten. */
async function rankUp(
  trx: Executor,
  player: { userId: number; rankType: string; exp: number },
  ledger: Ledger
): Promise<string | null> {
  const earned = earnedRank(
    player.rankType,
    getLevelProgression(player.exp).level,
    accuracyOf(ledger)
  );
  if (!earned) return null;
  const moved = await trx
    .updateTable('NewOrderPlayer')
    .set({ rankType: earned as RankType })
    .where('userId', '=', player.userId)
    .where('rankType', '=', player.rankType as RankType)
    .executeTakeFirst();
  return moved.numUpdatedRows > 0n ? earned : null;
}

/** For the dev tools: the same rank-up settle applies, on demand. */
export async function applyRankUp(trx: Executor, playerId: number): Promise<string | null> {
  const player = await trx
    .selectFrom('NewOrderPlayer')
    .select(['userId', 'rankType', 'exp'])
    .where('userId', '=', playerId)
    .forUpdate()
    .executeTakeFirst();
  return player ? rankUp(trx, player, await ledgerOf(trx, playerId)) : null;
}

export type SettleResult = { votes: number; xp: XpDelta[] };
const NOTHING: SettleResult = { votes: 0, xp: [] };

/** Pays out an item's graded votes once, and only when its outcome is final: a rating awaiting write-back can still be rerouted and its votes regraded. Idempotent via the row lock and settledAt. */
export async function settleItemVotes(
  trx: Executor,
  itemId: number,
  now: Date
): Promise<SettleResult> {
  const final = await trx
    .selectFrom('KnightsQueueItem')
    .select('id')
    .where('id', '=', itemId)
    .where(finalItem())
    .executeTakeFirst();
  if (!final) return NOTHING;

  const votes = await trx
    .selectFrom('KnightsVote')
    .select(['playerId', 'verdict', 'gold', 'createdAt'])
    .where('itemId', '=', itemId)
    .where('settledAt', 'is', null)
    .where('verdict', '<>', 'pending')
    .orderBy('playerId', 'asc')
    .forUpdate()
    .execute();
  if (votes.length === 0) return NOTHING;

  const players = await trx
    .selectFrom('NewOrderPlayer')
    .select(['userId', 'startAt'])
    .where(
      'userId',
      'in',
      votes.map((v) => v.playerId)
    )
    .execute();
  const startAt = new Map(players.map((p) => [p.userId, p.startAt]));

  const perPlayer = new Map<number, { xp: number; pending: number; earned: number }>();
  for (const vote of votes) {
    const reset = vote.createdAt < (startAt.get(vote.playerId) ?? new Date(0));
    const paid = vote.verdict === 'correct' && !reset;
    const gold = vote.gold ?? 0;
    const bulk = paid ? PROGRESSION.correctXp : 0;
    await trx
      .updateTable('KnightsVote')
      .set({ xp: sql<number>`"xp" + ${bulk}`, gold: paid ? gold : 0, settledAt: utc(now) })
      .where('itemId', '=', itemId)
      .where('playerId', '=', vote.playerId)
      .execute();

    const total = perPlayer.get(vote.playerId) ?? { xp: 0, pending: 0, earned: 0 };
    total.xp += bulk;
    total.pending += gold;
    total.earned += paid ? gold : 0;
    perPlayer.set(vote.playerId, total);
  }

  const xp: XpDelta[] = [];
  // Votes were read in player order, so concurrent settlements lock player rows in the same order.
  for (const [playerId, total] of perPlayer) {
    const ledger = await ledgerOf(trx, playerId);
    const after = await trx
      .updateTable('NewOrderPlayer')
      .set({
        exp: sql<number>`"exp" + ${total.xp}`,
        goldPending: sql<number>`GREATEST(0, "goldPending" - ${total.pending})`,
        goldEarned: sql<number>`"goldEarned" + ${total.earned}`,
        fervor: calculateFervor(ledger),
      })
      .where('userId', '=', playerId)
      .returning(['userId', 'rankType', 'exp'])
      .executeTakeFirst();
    if (after) await rankUp(trx, after, ledger);
    if (total.xp > 0) xp.push({ playerId, xp: total.xp });
  }
  return { votes: votes.length, xp };
}

/** Settles in its own transaction and mirrors the XP once it has committed. */
export async function settleAndMirror(
  db: Kysely<DB>,
  itemId: number,
  now: Date,
  mirror?: XpMirror
): Promise<SettleResult> {
  const result = await db.transaction().execute((trx) => settleItemVotes(trx, itemId, now));
  await mirrorXp(mirror, result.xp);
  return result;
}

/** Sweep for items finalised by a path that never calls settleItemVotes (moderator-app rulings) or that crashed first. */
export async function settleFinalItems(
  db: Kysely<DB>,
  { now, limit = 200, mirror }: { now: Date; limit?: number; mirror?: XpMirror }
): Promise<{ items: number; votes: number; failed: number }> {
  const due = await db
    .selectFrom('KnightsVote as v')
    .innerJoin('KnightsQueueItem as i', 'i.id', 'v.itemId')
    .select('v.itemId')
    .distinct()
    .where('v.settledAt', 'is', null)
    .where('v.verdict', '<>', 'pending')
    .where(finalItem('i'))
    .orderBy('v.itemId', 'asc')
    .limit(limit)
    .execute();

  let votes = 0;
  let failed = 0;
  for (const { itemId } of due) {
    try {
      votes += (await settleAndMirror(db, itemId, now, mirror)).votes;
    } catch (error) {
      failed++;
      console.error('knights: could not settle the votes of an item, it will be retried', {
        itemId,
        error,
      });
    }
  }
  return { items: due.length, votes, failed };
}
