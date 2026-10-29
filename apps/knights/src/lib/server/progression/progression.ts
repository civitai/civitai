import { sql, type Kysely, type Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { getLevelProgression } from '@civitai/shared/new-order-levels';
import { finalItem } from '../queue/item-state';
import { workOffSmites } from '../smites/smites.service';
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

/** Shared by fervor and accuracy. Excludes inconclusive and unsettled votes, and votes cast before the `startAt` reset. */
export async function ledgerOf(db: Executor, playerId: number): Promise<Ledger> {
  // Hidden checks count as graded answers beside the settled votes.
  const totals = await sql<{ graded: string; correct: string }>`
    SELECT count(*) AS graded, count(*) FILTER (WHERE w.verdict = 'correct') AS correct
    FROM (
      SELECT g.verdict FROM (
        SELECT v.verdict, v."createdAt" FROM "KnightsVote" v
        WHERE v."playerId" = ${playerId} AND v."settledAt" IS NOT NULL AND v.verdict IN ('correct', 'failed')
        UNION ALL
        SELECT CASE WHEN h.correct THEN 'correct' ELSE 'failed' END, h."createdAt" FROM "KnightsHiddenCheckAnswer" h
        WHERE h."playerId" = ${playerId}
      ) g
      WHERE g."createdAt" >= COALESCE((SELECT "startAt" FROM "NewOrderPlayer" WHERE "userId" = ${playerId}), 'epoch')
      ORDER BY g."createdAt" DESC
      LIMIT ${PROGRESSION.fervorWindow}
    ) w`.execute(db);
  const row = totals.rows[0];
  return { correct: Number(row.correct), graded: Number(row.graded) };
}

const rankEarnedBy = (player: { rankType: string; exp: number }, ledger: Ledger) =>
  earnedRank(player.rankType, getLevelProgression(player.exp).level, accuracyOf(ledger));

/** Dev tools only: runs the settle-time rank-up on demand. */
export async function applyRankUp(trx: Executor, playerId: number): Promise<string | null> {
  const player = await trx
    .selectFrom('NewOrderPlayer')
    .select(['rankType', 'exp'])
    .where('userId', '=', playerId)
    .forUpdate()
    .executeTakeFirst();
  if (!player) return null;
  const earned = rankEarnedBy(player, await ledgerOf(trx, playerId));
  if (!earned) return null;
  await trx
    .updateTable('NewOrderPlayer')
    .set({ rankType: earned as RankType })
    .where('userId', '=', playerId)
    .execute();
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
      .where('itemId', '=', itemId)
      .where('playerId', '=', vote.playerId)
      .execute();

    const total = perPlayer.get(vote.playerId) ?? { xp: 0, pending: 0, earned: 0, correct: 0 };
    total.xp += bulk;
    total.pending += gold;
    total.earned += paid ? gold : 0;
    if (paid) total.correct++;
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
    const earned = locked ? rankEarnedBy(locked, ledger) : null;
    await trx
      .updateTable('NewOrderPlayer')
      .set({
        fervor: calculateFervor(ledger),
        ...(earned ? { rankType: earned as RankType } : {}),
      })
      .where('userId', '=', playerId)
      .execute();
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
