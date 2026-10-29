import { sql, type Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { recordVoteDay } from '../daily/daily.service';
import { goldForRank, PROGRESSION } from '../progression/config';
import { ledgerOf } from '../progression/progression';
import { standingOf } from '../progression/rating';
import { isRank } from '../ranks';
import { SMITES } from '../smites/config';
import { activeSmiteCount } from '../smites/smites.service';
import { canVote } from './ranks';
import { levelForExp, voteWeight } from './resolution';

/** The ledger rows of queue votes and of hidden checks are written here and nowhere else, so they cannot drift apart. */
export type VoteRejection =
  | 'no-player'
  | 'not-eligible'
  | 'bad-answer'
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
};

export type InsertedVote = {
  status: 'inserted';
  player: { rankType: string; startAt: Date };
  gold: number;
};

/** Validates a player's answer and writes the pending ledger row. Credit follows with `creditVote`. */
export async function insertVote(
  trx: Transaction<DB>,
  input: { userId: number; answer: string; now: Date; lockPlayer?: boolean },
  subject: VoteSubject
): Promise<{ status: 'rejected'; reason: VoteRejection } | InsertedVote> {
  const rejected = (reason: VoteRejection) => ({ status: 'rejected' as const, reason });

  let query = trx
    .selectFrom('NewOrderPlayer')
    .select(['rankType', 'exp', 'startAt'])
    .where('userId', '=', input.userId);
  if (input.lockPlayer) query = query.forUpdate();
  const player = await query.executeTakeFirst();
  if (!player) return rejected('no-player');
  if (!isRank(player.rankType) || !canVote(player.rankType, subject.stage)) {
    return rejected('not-eligible');
  }
  if (!subject.options.some((o) => o.value === input.answer)) return rejected('bad-answer');

  const already = await trx
    .selectFrom('KnightsVote')
    .select('playerId')
    .where('itemId', '=', subject.itemId)
    .where('playerId', '=', input.userId)
    .executeTakeFirst();
  if (already) return rejected('already-voted');

  const smites = await activeSmiteCount(trx, input.userId);
  // A career reset is pending; the player does not play on until it is done.
  if (smites >= SMITES.max) return rejected('reset-pending');

  const { belowBar } = standingOf(player.rankType, await ledgerOf(trx, input.userId));
  // A vote that weighs nothing could still be the one that tips a split into a decision.
  const weight = voteWeight({
    rank: player.rankType,
    level: levelForExp(player.exp),
    smites,
    belowBar,
  });
  if (weight <= 0) return rejected('no-weight');
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
      weight,
      xp: PROGRESSION.voteXp,
      gold,
      ...(subject.labelled ? { labelled: true } : {}),
    })
    .execute();
  return { status: 'inserted', player, gold };
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
