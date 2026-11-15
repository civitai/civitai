import { sql, type Kysely, type SqlBool, type Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { getLevelProgression } from './levels';
import { finalItem } from '../queue/item-state';
import { workOffSmites } from '../smites/smites.service';
import { metrics } from '../metrics';
import { grantRankBadges } from './badges';
import { PROGRESSION, RANK_LADDER } from './config';
import { accuracyOf, earnedRank, type Ledger } from './rating';
import { mirrorXp, type XpDelta, type XpMirror } from './legacy-exp';

type Executor = Kysely<DB> | Transaction<DB>;
type RankType = DB['NewOrderPlayer']['rankType'];

/** The window accuracy and rank are read from (fervor has its own, in `fervor.ts`). Excludes inconclusive and unsettled votes, and votes cast before the `startAt` reset. */
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
    .limit(PROGRESSION.accuracyWindow)
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

/**
 * The bulk XP the player's votes are still to be paid: `correctXp` on each vote since the `startAt` reset that has no
 * payout yet and is not graded wrong, so a vote awaiting its verdict counts, and so does one graded correct but not yet
 * settled. The vote XP is already in `exp`. Hidden checks settle through the same payout, so they count alike.
 * Reads the player's own votes on (playerId, createdAt), which also prunes the monthly partitions to those since the reset.
 */
export async function pendingXpOf(db: Executor, playerId: number): Promise<number> {
  const { n } = await db
    .selectFrom('KnightsVote as v')
    .select(sql<string>`count(*)`.as('n'))
    .where('v.playerId', '=', playerId)
    .where(
      sql<SqlBool>`v."createdAt" >= (SELECT "startAt" FROM "NewOrderPlayer" WHERE "userId" = ${playerId})`
    )
    .where('v.settledAt', 'is', null)
    .where('v.verdict', 'in', ['pending', 'correct'])
    .executeTakeFirstOrThrow();
  return Number(n) * PROGRESSION.correctXp;
}

/**
 * Distinct UTC days since the career began on which the player cast a vote. `KnightsPlayerDay` has one row per
 * player per day, so this is a count over at most a few hundred rows on its primary key, not over the vote ledger.
 * The day of a reset counts, even for votes cast before it.
 */
export async function daysPlayedOf(db: Executor, playerId: number): Promise<number> {
  const { n } = await db
    .selectFrom('KnightsPlayerDay as d')
    .select(sql<string>`count(*)`.as('n'))
    .where('d.playerId', '=', playerId)
    .where('d.votes', '>', 0)
    .where(
      sql<SqlBool>`d."day" >= COALESCE((SELECT "startAt"::date FROM "NewOrderPlayer" WHERE "userId" = d."playerId"), 'epoch')`
    )
    .executeTakeFirstOrThrow();
  return Number(n);
}

/** Days are read only when level and accuracy already earn a rank that asks for them. */
async function rankEarnedBy(
  db: Executor,
  playerId: number,
  player: { rankType: string; exp: number },
  ledger: Ledger
) {
  const level = getLevelProgression(player.exp).level;
  const accuracy = accuracyOf(ledger);
  const withoutDayGate = earnedRank(player.rankType, level, accuracy, Infinity);
  const gated = RANK_LADDER.find((entry) => entry.rank === withoutDayGate)?.minDaysPlayed;
  if (!gated) return withoutDayGate;
  return earnedRank(player.rankType, level, accuracy, await daysPlayedOf(db, playerId));
}

/** Dev tools only: runs the settle-time rank-up on demand. */
export async function applyRankUp(trx: Executor, playerId: number): Promise<string | null> {
  const player = await trx
    .selectFrom('NewOrderPlayer')
    .select(['rankType', 'exp'])
    .where('userId', '=', playerId)
    .forUpdate()
    .executeTakeFirst();
  if (!player) return null;
  const earned = await rankEarnedBy(trx, playerId, player, await ledgerOf(trx, playerId));
  if (!earned) return null;
  await trx
    .updateTable('NewOrderPlayer')
    .set({ rankType: earned as RankType })
    .where('userId', '=', playerId)
    .execute();
  await grantRankBadges(trx, playerId, earned);
  return earned;
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
    .select(['itemId', 'playerId', 'verdict', 'gold', 'createdAt'])
    .where('itemId', '=', itemId)
    .where('settledAt', 'is', null)
    .where('verdict', '<>', 'pending')
    .orderBy('playerId', 'asc')
    .forUpdate()
    .execute();
  return payOutVotes(trx, votes, now);
}

export type GradedVote = {
  itemId: number;
  playerId: number;
  verdict: string;
  gold: number | null;
  createdAt: Date;
};

/** Pays graded, unsettled votes (already row-locked, ordered by player) and marks them settled. Shared by queue items and hidden checks. */
export async function payOutVotes(
  trx: Executor,
  votes: GradedVote[],
  now: Date
): Promise<SettleResult> {
  if (votes.length === 0) return NOTHING;

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

  const perPlayer = new Map<
    number,
    { xp: number; pending: number; earned: number; correct: number }
  >();
  for (const vote of votes) {
    const reset = vote.createdAt < (startAt.get(vote.playerId) ?? new Date(0));
    const paid = vote.verdict === 'correct' && !reset;
    const gold = vote.gold ?? 0;
    const bulk = paid ? PROGRESSION.correctXp : 0;
    await trx
      .updateTable('KnightsVote')
      .set({ xp: sql<number>`"xp" + ${bulk}`, gold: paid ? gold : 0, settledAt: utc(now) })
      .where('itemId', '=', vote.itemId)
      .where('playerId', '=', vote.playerId)
      .execute();

    const total = perPlayer.get(vote.playerId) ?? { xp: 0, pending: 0, earned: 0, correct: 0 };
    total.xp += bulk;
    total.pending += reset ? 0 : gold;
    total.earned += paid ? gold : 0;
    if (paid) {
      total.correct++;
      metrics.goldEarned(vote.itemId < 0 ? 'hidden_check' : 'vote', gold);
    }
    perPlayer.set(vote.playerId, total);
  }

  const xp: XpDelta[] = [];
  // Votes were read in player order, so concurrent settlements lock player rows in the same order.
  for (const [playerId, total] of perPlayer) {
    const locked = await trx
      .updateTable('NewOrderPlayer')
      .set({
        exp: sql<number>`"exp" + ${total.xp}`,
        goldPending: sql<number>`GREATEST(0, "goldPending" - ${total.pending})`,
        goldEarned: sql<number>`"goldEarned" + ${total.earned}`,
      })
      .where('userId', '=', playerId)
      .returning(['rankType', 'exp'])
      .executeTakeFirst();
    // Read only now: the update above took the row lock, so a settlement that committed first is in the ledger.
    const ledger = await ledgerOf(trx, playerId);
    const earned = locked ? await rankEarnedBy(trx, playerId, locked, ledger) : null;
    if (earned) {
      await trx
        .updateTable('NewOrderPlayer')
        .set({ rankType: earned as RankType })
        .where('userId', '=', playerId)
        .execute();
      await grantRankBadges(trx, playerId, earned);
      metrics.rankUp(earned, playerId);
    }
    if (total.correct > 0) await workOffSmites(trx, playerId, now);
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
