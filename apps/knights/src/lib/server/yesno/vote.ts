import type { Kysely } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { PROGRESSION } from '../progression/config';
import { mirrorXp } from '../progression/legacy-exp';
import {
  ensureMonthPartition,
  lockItemVoters,
  pacingGate,
  type QueueDeps,
  type RejectReason,
} from '../queue/queue.service';
import { creditVote, insertVote } from '../queue/vote-record';
import { decideYesNo } from './decide';
import { playableItems } from './items';
import { YESNO_ANSWERS } from './keys';
import { settleYesNoVotes } from './settle';

export type YesNoVoteResult =
  | { status: 'rejected'; reason: RejectReason }
  | { status: 'limited'; until: Date }
  | { status: 'recorded' };

/**
 * Takes a yes/no answer as an ordinary vote: the same pacing, join gate, reset refusal, weight, XP, pending gold and daily tally as a
 * rating vote, written to the same ledger under the item's own id. The item row lock serialises its votes, so exactly one vote
 * closes it. What the caller learns never says whether it did.
 */
export async function castYesNoVote(
  db: Kysely<DB>,
  input: { userId: number; itemId: number; answer: string; isModerator?: boolean },
  deps: Pick<QueueDeps, 'now' | 'voteLimits' | 'mirrorXp'>
): Promise<YesNoVoteResult> {
  const now = deps.now();
  await ensureMonthPartition(db, { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 });

  const result = await db.transaction().execute(async (trx): Promise<YesNoVoteResult> => {
    const rejected = (reason: RejectReason) => ({ status: 'rejected' as const, reason });

    const until = await pacingGate(trx, input, now, deps);
    if (until) return { status: 'limited', until };

    const locked = await trx
      .selectFrom('KnightsQueueItem')
      .select(['id', 'status'])
      .where('id', '=', input.itemId)
      .forUpdate()
      .executeTakeFirst();
    if (!locked || locked.status !== 'Open') return rejected('not-open');

    const item = await playableItems(trx)
      .where('i.id', '=', input.itemId)
      .select([
        'i.id',
        'i.questionKey',
        'i.imageId',
        'i.minRank',
        'i.votesNeeded',
        'i.prompt',
        'q.maxVotes',
      ])
      .executeTakeFirst();
    if (!item) return rejected('unavailable');

    // The same words about the same image under another id are the same question to the player.
    const asked = await trx
      .selectFrom('KnightsVote as v')
      .innerJoin('KnightsQueueItem as o', 'o.id', 'v.itemId')
      .select('v.itemId')
      .where('v.playerId', '=', input.userId)
      .where('o.imageId', '=', item.imageId)
      .where('o.prompt', '=', item.prompt)
      .executeTakeFirst();
    if (asked) return rejected('already-voted');

    const vote = await insertVote(
      trx,
      { ...input, now },
      {
        itemId: item.id,
        questionKey: item.questionKey,
        imageId: item.imageId,
        stage: item.minRank,
        options: [...YESNO_ANSWERS],
      }
    );
    if (vote.status === 'rejected') return rejected(vote.reason);

    await trx
      .updateTable('KnightsQueueItem')
      .set({ voteCount: (eb) => eb('voteCount', '+', 1), updatedAt: utc(now) })
      .where('id', '=', item.id)
      .execute();
    const answers = await trx
      .selectFrom('KnightsVote')
      .select('answer')
      .where('itemId', '=', item.id)
      .execute();
    const decision = decideYesNo(answers, { needed: item.votesNeeded, max: item.maxVotes });

    // Closing settles every voter's player row; taking the locks first, in id order, keeps all transactions in one order.
    if (decision.kind !== 'pending') await lockItemVoters(trx, item.id);
    await creditVote(trx, {
      userId: input.userId,
      itemId: item.id,
      now,
      player: vote.player,
      gold: vote.gold,
    });
    if (decision.kind === 'pending') return { status: 'recorded' };

    await trx
      .updateTable('KnightsQueueItem')
      .set(
        decision.kind === 'consensus'
          ? {
              status: 'Consensus',
              resolvedValue: decision.value,
              resolvedAt: utc(now),
              resolvedBy: input.userId,
            }
          : { status: 'Closed', reason: 'no-consensus', resolvedAt: utc(now) }
      )
      .where('id', '=', item.id)
      .execute();
    await trx
      .updateTable('KnightsVote')
      .set(
        decision.kind === 'consensus'
          ? {
              verdict: (eb) =>
                eb
                  .case()
                  .when('answer', '=', decision.value)
                  .then('matched')
                  .else('unmatched')
                  .end(),
            }
          : { verdict: 'inconclusive' }
      )
      .where('itemId', '=', item.id)
      .execute();
    await settleYesNoVotes(trx, item.id, now);
    return { status: 'recorded' };
  });

  if (result.status === 'recorded') {
    await mirrorXp(deps.mirrorXp, [{ playerId: input.userId, xp: PROGRESSION.voteXp }]);
  }
  return result;
}
