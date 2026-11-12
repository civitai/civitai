import { sql, type Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { asksBlockReason, blockReasonProblem } from '../../block-reasons';
import { recordVoteDay } from '../daily/daily.service';
import { heldSql } from '../conversion/held';
import { metrics, type VoteKind } from '../metrics';
import { goldForRank, PROGRESSION } from '../progression/config';
import { ledgerOf } from '../progression/progression';
import { standingOf } from '../progression/rating';
import { isRank } from '../ranks';
import { SMITES } from '../smites/config';
import { activeSmiteCount } from '../smites/smites.service';
import { canVote } from './ranks';
import { levelForExp, voteWeight } from './resolution';

/** First key of the per-player advisory lock that serialises a player's votes. */
const VOTE_PACING_LOCK_NAMESPACE = 7_301;

/** Held to the end of the transaction; taking it again in the same transaction is free. */
export async function lockPlayerVoting(trx: Transaction<DB>, userId: number): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${VOTE_PACING_LOCK_NAMESPACE}, ${userId})`.execute(trx);
}

/** The ledger rows of queue votes and of hidden checks are written here and nowhere else, so they cannot drift apart. */
export type VoteRejection =
  | 'no-player'
  | 'not-eligible'
  | 'bad-answer'
  | 'bad-block-reason'
  | 'already-voted'
  | 'no-weight'
  | 'reset-pending';

export type VoteSubject = {
  /** A queue item's id; a hidden check is the negative of its reference image's id. */
  itemId: number;
  questionKey: string;
  imageId: number;
  /** The rank the subject asks for. */
  stage: string;
  options: { value: string }[];
  /** Checks are never labelled: labels come from consensus only. */
  labelled?: boolean;
  /**
   * Set when the caller already enforces its own one-judgment rule. A yes/no axis holds several questions per image, told
   * apart by their prompt, so (image, question key) is not the unit there.
   */
  ownJudgmentRule?: boolean;
};

export type InsertedVote = {
  status: 'inserted';
  player: { rankType: string; startAt: Date };
  gold: number;
  /** What the vote was stored with: 0 for a held player's. */
  weight: number;
};

/** Only yes/no questions bring their own one-judgment rule. */
const voteKind = (subject: VoteSubject): VoteKind =>
  subject.itemId < 0 ? 'hidden_check' : subject.ownJudgmentRule ? 'yesno' : 'rating';

/**
 * Validates a player's answer and writes the pending ledger row. Credit follows with `creditVote`.
 *
 * A player judges an image once per question key, across items, stages and re-queues: a second row is refused as
 * `already-voted`. The check runs under the player's advisory lock, because the partitioned ledger cannot carry a unique key
 * on (player, image, question) (a unique index must include the partition column `createdAt`).
 */
export async function insertVote(
  trx: Transaction<DB>,
  input: {
    userId: number;
    answer: string;
    /** Why the voter blocked the image: required with Blocked on the rating question, refused with anything else. */
    blockReason?: string | null;
    now: Date;
    lockPlayer?: boolean;
  },
  subject: VoteSubject
): Promise<{ status: 'rejected'; reason: VoteRejection } | InsertedVote> {
  const rejected = (reason: VoteRejection) => ({ status: 'rejected' as const, reason });

  await lockPlayerVoting(trx, input.userId);
  let query = trx
    .selectFrom('NewOrderPlayer as p')
    .select(['p.rankType', 'p.exp', 'p.startAt', heldSql('p.userId').as('held')])
    .where('p.userId', '=', input.userId);
  if (input.lockPlayer) query = query.forUpdate();
  const player = await query.executeTakeFirst();
  if (!player) return rejected('no-player');
  if (!isRank(player.rankType) || !canVote(player.rankType, subject.stage)) {
    return rejected('not-eligible');
  }
  if (!subject.options.some((o) => o.value === input.answer)) return rejected('bad-answer');
  const reasonProblem = asksBlockReason(subject.questionKey)
    ? blockReasonProblem(input.answer, input.blockReason)
    : input.blockReason
    ? 'unexpected'
    : null;
  if (reasonProblem) return rejected('bad-block-reason');

  const already = await trx
    .selectFrom('KnightsVote')
    .select('playerId')
    .where('itemId', '=', subject.itemId)
    .where('playerId', '=', input.userId)
    .executeTakeFirst();
  if (already) return rejected('already-voted');

  if (!subject.ownJudgmentRule) {
    const judged = await trx
      .selectFrom('KnightsVote')
      .select('playerId')
      .where('playerId', '=', input.userId)
      .where('imageId', '=', subject.imageId)
      .where('questionKey', '=', subject.questionKey)
      .limit(1)
      .executeTakeFirst();
    if (judged) return rejected('already-voted');
  }

  const smites = await activeSmiteCount(trx, input.userId);
  // A career reset is pending; the player does not play on until it is done.
  if (smites >= SMITES.max) return rejected('reset-pending');

  const { belowBar } = standingOf(player.rankType, await ledgerOf(trx, input.userId));
  const computed = voteWeight({
    rank: player.rankType,
    level: levelForExp(player.exp),
    smites,
    belowBar,
  });
  // A vote that weighs nothing could still be the one that tips a split into a decision, so it is refused. A held
  // player's vote is the exception: it is recorded, graded and paid but stored at 0 (only when its computed weight is positive), which `decideChoice` and
  // `escalateExpired` ignore. Clearing the hold does not re-weight votes already cast.
  if (computed <= 0) return rejected('no-weight');
  const weight = player.held ? 0 : computed;
  const gold = goldForRank(player.rankType, belowBar);

  await trx
    .insertInto('KnightsVote')
    .values({
      itemId: subject.itemId,
      playerId: input.userId,
      createdAt: utc(input.now),
      questionKey: subject.questionKey,
      imageId: subject.imageId,
      stage: subject.stage,
      answer: input.answer,
      blockReason: input.blockReason || null,
      weight,
      xp: PROGRESSION.voteXp,
      gold,
      ...(subject.labelled ? { labelled: true } : {}),
    })
    .execute();
  metrics.vote(voteKind(subject));
  return {
    status: 'inserted',
    player: { rankType: player.rankType, startAt: player.startAt },
    gold,
    weight,
  };
}

/**
 * Pays the immediate part of a vote: XP, then the day's tally and pending gold clamped to the rank's daily cap.
 * Must run after the player row is locked (`recordVoteDay` relies on it).
 */
export async function creditVote(
  trx: Transaction<DB>,
  input: {
    userId: number;
    itemId: number;
    now: Date;
    player: { rankType: string; startAt: Date };
    gold: number;
  }
): Promise<void> {
  await trx
    .updateTable('NewOrderPlayer')
    .set({ exp: sql<number>`"exp" + ${PROGRESSION.voteXp}` })
    .where('userId', '=', input.userId)
    .execute();

  const day = await recordVoteDay(trx, {
    playerId: input.userId,
    rank: input.player.rankType,
    gold: input.gold,
    now: input.now,
    startAt: input.player.startAt,
  });
  if (day.gold !== input.gold) {
    await trx
      .updateTable('KnightsVote')
      .set({ gold: day.gold })
      .where('itemId', '=', input.itemId)
      .where('playerId', '=', input.userId)
      .where('createdAt', '=', utc(input.now))
      .execute();
  }
  metrics.goldEarned('streak_bonus', day.bonus);
  if (day.gold > 0 || day.bonus > 0) {
    await trx
      .updateTable('NewOrderPlayer')
      .set({
        goldPending: sql<number>`"goldPending" + ${day.gold}`,
        goldEarned: sql<number>`"goldEarned" + ${day.bonus}`,
      })
      .where('userId', '=', input.userId)
      .execute();
  }
}
