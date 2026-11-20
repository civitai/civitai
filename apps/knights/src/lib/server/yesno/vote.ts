import type { Kysely } from 'kysely';
import { MOD_TAG_REVIEW_SOURCE, removalLowersLevel } from '@civitai/db/knights';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { PROGRESSION } from '../progression/config';
import { mirrorXp, type XpDelta } from '../progression/legacy-exp';
import {
  ensureMonthPartition,
  lockItemVoters,
  lockPlayerVoting,
  pacingGate,
  staffedRanks,
  type QueueDeps,
  type RejectReason,
} from '../queue/queue.service';
import { nextStaffedRank } from '../queue/ranks';
import { creditVote, insertVote } from '../queue/vote-record';
import { decideYesNo } from './decide';
import { tagIdOf } from './tag-review';
import { playableItems } from './items';
import { YESNO_ANSWERS } from './keys';
import { closeYesNoItem } from './close';

export type YesNoVoteResult =
  | { status: 'rejected'; reason: RejectReason }
  | { status: 'limited'; until: Date }
  | { status: 'recorded' };

/**
 * Takes a yes/no answer as a rating vote in every way: the same pacing, join gate, reset refusal, weight, XP, pending gold and daily
 * tally, written to the same ledger under the item's own id, and graded and paid the same way when the question has its consensus. The item row lock serialises its votes, so exactly one vote
 * closes it. What the caller learns never says whether it did.
 */
export async function castYesNoVote(
  db: Kysely<DB>,
  input: { userId: number; itemId: number; answer: string; isModerator?: boolean },
  deps: Pick<QueueDeps, 'now' | 'voteLimits' | 'mirrorXp'>
): Promise<YesNoVoteResult> {
  const now = deps.now();
  await ensureMonthPartition(db, { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 });

  const { result, xp } = await db
    .transaction()
    .execute(async (trx): Promise<{ result: YesNoVoteResult; xp: XpDelta[] }> => {
      const rejected = (reason: RejectReason) => ({
        result: { status: 'rejected' as const, reason },
        xp: [] as XpDelta[],
      });

      // Serialises one player's answers even when pacing is skipped, so the same-words check below cannot be raced.
      await lockPlayerVoting(trx, input.userId);
      const until = await pacingGate(trx, input, now, deps);
      if (until) return { result: { status: 'limited', until }, xp: [] };

      const locked = await trx
        .selectFrom('KnightsQueueItem')
        .select(['id', 'status', 'source'])
        .where('id', '=', input.itemId)
        .forUpdate()
        .executeTakeFirst();
      if (!locked || locked.status !== 'Open') return rejected('not-open');

      const tagReview = locked.source === MOD_TAG_REVIEW_SOURCE;
      const item = await playableItems(trx, { tagReview })
        .where('i.id', '=', input.itemId)
        .select(['i.id', 'i.questionKey', 'i.imageId', 'i.minRank', 'i.prompt', 'i.meta'])
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
          ownJudgmentRule: true,
        }
      );
      if (vote.status === 'rejected') return rejected(vote.reason);

      const voted: XpDelta[] = [{ playerId: input.userId, xp: PROGRESSION.voteXp }];
      // A held player's answer (weight 0) decides nothing, so it must not make the question look answered: swept as
      // stale, ordered first in the feed or locked against rewording.
      if (vote.weight > 0) {
        await trx
          .updateTable('KnightsQueueItem')
          .set({ voteCount: (eb) => eb('voteCount', '+', 1), updatedAt: utc(now) })
          .where('id', '=', item.id)
          .execute();
      }
      // Each stage decides on its own answers, by the rating stage rule; earlier stages' answers wait for the outcome and are graded by it.
      const answers = await trx
        .selectFrom('KnightsVote')
        .select(['answer', 'weight'])
        .where('itemId', '=', item.id)
        .where('stage', '=', item.minRank)
        .execute();
      let decision = decideYesNo(answers, item.minRank);
      // A tag removal that would lower the image's rating needs more than the minimum: read now, under the item lock.
      if (
        tagReview &&
        decision.kind === 'consensus' &&
        decision.value === 'no' &&
        decideYesNo(answers, item.minRank, { noSettlesAtNeeded: false }).kind === 'pending' &&
        (await removalLowersLevel(trx, item.imageId, tagIdOf(item.meta)))
      )
        decision = { kind: 'pending' };

      // Closing settles every voter's player row; taking the locks first, in id order, keeps all transactions in one order.
      if (decision.kind !== 'pending') await lockItemVoters(trx, item.id);
      await creditVote(trx, {
        userId: input.userId,
        itemId: item.id,
        now,
        player: vote.player,
        gold: vote.gold,
      });
      if (decision.kind === 'pending') return { result: { status: 'recorded' }, xp: voted };

      // A stage that runs out of answers without a majority hands the question to the next staffed rank, as a rating item does.
      // The last stage gives it up: yes/no questions never go to the Inquisitors, and carry no stage deadline.
      if (decision.kind === 'exhausted') {
        const next = nextStaffedRank(item.minRank, await staffedRanks(trx, now));
        if (next && next !== 'Inquisitor') {
          await trx
            .updateTable('KnightsQueueItem')
            .set({ minRank: next, escalatedAt: utc(now), updatedAt: utc(now) })
            .where('id', '=', item.id)
            .execute();
          return { result: { status: 'recorded' }, xp: voted };
        }
      }

      const settled = await closeYesNoItem(
        trx,
        item.id,
        decision.kind === 'consensus'
          ? { kind: 'consensus', value: decision.value, by: input.userId }
          : { kind: 'none', reason: 'no-consensus' },
        now
      );
      return { result: { status: 'recorded' }, xp: [...voted, ...settled] };
    });

  await mirrorXp(deps.mirrorXp, xp);
  return result;
}
