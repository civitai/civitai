import { sql, type Kysely, type SqlBool, type Transaction } from 'kysely';
import { REFERENCE_SOURCE, REFERENCE_STATUS, servableImage } from '@civitai/db/knights';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { mirrorXp, type XpDelta, type XpMirror } from '../progression/legacy-exp';
import { payOutVotes, type GradedVote } from '../progression/progression';
import { metrics } from '../metrics';
import { SMITES } from '../smites/config';
import { activeSmiteCount, issueSmite, resetNow, type ResetDeps } from '../smites/smites.service';
import type { HiddenCheckSettings } from './config';
import { isCloseAnswer, isSevereUnderRating } from './hidden.service';
import { SMITE_REASON } from './notices';

type Executor = Kysely<DB> | Transaction<DB>;
type Due = GradedVote & { answer: string };

/** What grading one check did: its verdict, the warning or smite it cost, and the player's active smites after it. */
export type CheckOutcome = {
  playerId: number;
  verdict: 'correct' | 'failed' | 'inconclusive';
  /** `close`: one level off the known answer, graded inconclusive (`isCloseAnswer`). */
  consequence: 'warning' | 'smite' | 'close' | null;
  smites: number;
};

/**
 * Grades checks inside the caller's transaction: verdict, payout (bulk XP and gold for a right answer, nothing for a wrong one,
 * and a right answer works smites off), and a warning or smite for a wrong one. `resetFor` holds the players who reached the
 * smite limit; the caller resets them once the transaction has committed.
 */
export async function gradeHiddenVotes(
  trx: Executor,
  due: Due[],
  { now, settings }: { now: Date; settings: HiddenCheckSettings }
): Promise<{ outcomes: CheckOutcome[]; xp: XpDelta[]; resetFor: number[] }> {
  if (due.length === 0) return { outcomes: [], xp: [], resetFor: [] };

  // Player rows first, in id order, before any reference image: the vote path holds its player row when it grades, so both
  // paths lock player then reference and cannot deadlock. A no-op for a player this transaction already holds.
  await trx
    .selectFrom('NewOrderPlayer')
    .select('userId')
    .where('userId', 'in', [...new Set(due.map((v) => v.playerId))])
    .orderBy('userId', 'asc')
    .forUpdate()
    .execute();

  // A check whose image has since gone (removed, blocked, unpublished, Private post) is not graded: nothing is paid or penalised.
  const known = new Map(
    (
      await trx
        .selectFrom('KnightsReferenceImage as r')
        .innerJoin('Image as img', 'img.id', 'r.imageId')
        .innerJoin('Post as p', 'p.id', 'img.postId')
        .select(['r.id', 'r.answer'])
        .where('r.id', 'in', [...new Set(due.map((v) => -v.itemId))])
        // A reference retired after the answer (e.g. a bad ruling pulled) no longer grades anyone.
        .where('r.status', '=', REFERENCE_STATUS.active)
        .where(servableImage)
        .execute()
    ).map((r) => [r.id, r.answer])
  );
  const gradedVotes = due.map((v) => {
    const answer = known.get(-v.itemId);
    const close = answer !== undefined && isCloseAnswer(v.answer, answer);
    return {
      ...v,
      close,
      verdict: (answer === undefined || close
        ? 'inconclusive'
        : v.answer === answer
        ? 'correct'
        : 'failed') as CheckOutcome['verdict'],
    };
  });
  for (const v of gradedVotes) {
    await trx
      .updateTable('KnightsVote')
      .set({ verdict: v.verdict })
      .where('itemId', '=', v.itemId)
      .where('playerId', '=', v.playerId)
      .where('createdAt', '=', utc(v.createdAt))
      .execute();
    // A close answer is no failure for the player but still a miss on the reference, so borderline checks keep retiring.
    if (v.verdict !== 'inconclusive' || v.close) {
      await trx
        .updateTable('KnightsReferenceImage')
        .set({
          answers: sql<number>`"answers" + 1`,
          failures: sql<number>`"failures" + ${v.verdict === 'failed' || v.close ? 1 : 0}`,
        })
        .where('id', '=', -v.itemId)
        .execute();
    }
  }

  // A check most players get wrong more likely has a wrong or unclear known answer than bad-faith players: stop serving it.
  const counted = [
    ...new Set(
      gradedVotes.filter((v) => v.verdict !== 'inconclusive' || v.close).map((v) => -v.itemId)
    ),
  ];
  if (counted.length > 0) {
    await trx
      .updateTable('KnightsReferenceImage')
      .set({ status: REFERENCE_STATUS.retired, updatedAt: utc(now) })
      .where('id', 'in', counted)
      .where('status', '=', REFERENCE_STATUS.active)
      .where('source', '!=', REFERENCE_SOURCE.core)
      .where('answers', '>=', settings.retireMinAnswers)
      .where(sql<SqlBool>`"failures" > "answers" * ${settings.retireFailureRate}::float8`)
      .execute();
  }

  const paid = await payOutVotes(trx, gradedVotes, now);

  const startAt = new Map(
    (
      await trx
        .selectFrom('NewOrderPlayer')
        .select(['userId', 'startAt'])
        .where('userId', 'in', [...new Set(gradedVotes.map((v) => v.playerId))])
        .execute()
    ).map((p) => [p.userId, p.startAt])
  );
  const resetFor = new Set<number>();
  const outcomes: CheckOutcome[] = [];
  for (const v of gradedVotes) {
    const since = startAt.get(v.playerId);
    if (v.close) {
      // Marked so the notice and the judgment history can say it was close.
      await trx
        .updateTable('KnightsVote')
        .set({ consequence: 'close' })
        .where('itemId', '=', v.itemId)
        .where('playerId', '=', v.playerId)
        .where('createdAt', '=', utc(v.createdAt))
        .execute();
      outcomes.push({
        playerId: v.playerId,
        verdict: v.verdict,
        consequence: 'close',
        smites: await activeSmiteCount(trx, v.playerId),
      });
      continue;
    }
    // A wrong answer from before the last career reset was wiped with it.
    if (v.verdict !== 'failed' || !since || v.createdAt < since) {
      outcomes.push({
        playerId: v.playerId,
        verdict: v.verdict,
        consequence: null,
        smites: await activeSmiteCount(trx, v.playerId),
      });
      continue;
    }

    const windowStart = new Date(
      Math.max(now.getTime() - settings.failureWindowHours * 3_600_000, since.getTime())
    );
    const { n } = await trx
      .selectFrom('KnightsVote')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('playerId', '=', v.playerId)
      .where('itemId', '<', 0)
      .where('consequence', 'in', ['warning', 'smite'])
      .where('settledAt', '>=', utc(windowStart))
      .executeTakeFirstOrThrow();
    const known_ = known.get(-v.itemId) as string;
    const smites = Number(n) >= 1 || isSevereUnderRating(v.answer, known_, settings.severeDistance);

    await trx
      .updateTable('KnightsVote')
      .set({ consequence: smites ? 'smite' : 'warning' })
      .where('itemId', '=', v.itemId)
      .where('playerId', '=', v.playerId)
      .where('createdAt', '=', utc(v.createdAt))
      .execute();
    let active = await activeSmiteCount(trx, v.playerId);
    if (smites) {
      active = await issueSmite(trx, { playerId: v.playerId, reason: SMITE_REASON, now });
      if (active >= SMITES.max) resetFor.add(v.playerId);
    }
    outcomes.push({
      playerId: v.playerId,
      verdict: v.verdict,
      consequence: smites ? 'smite' : 'warning',
      smites: active,
    });
  }

  return { outcomes, xp: paid.xp, resetFor: [...resetFor] };
}

/**
 * Sweeps the hidden checks still pending once they have waited `settleDelayMinutes`. A check answered through the play page is
 * graded in its own request (`answerHiddenCheck` with `grade`); this catches the rest, such as checks answered before that
 * shipped.
 */
export async function settleHiddenChecks(
  db: Kysely<DB>,
  deps: ResetDeps & {
    now: Date;
    settings: HiddenCheckSettings;
    mirrorXp?: XpMirror;
    limit?: number;
  }
): Promise<{ graded: number; failed: number; resets: number }> {
  const { now, settings } = deps;
  const cutoff = new Date(now.getTime() - settings.settleDelayMinutes * 60_000);

  const { outcomes, xp, resetFor } = await db.transaction().execute(async (trx) => {
    const due: Due[] = await trx
      .selectFrom('KnightsVote')
      .select(['itemId', 'playerId', 'verdict', 'gold', 'createdAt', 'answer'])
      .where('itemId', '<', 0)
      .where('settledAt', 'is', null)
      .where('verdict', '=', 'pending')
      .where('createdAt', '<=', utc(cutoff))
      .orderBy('playerId', 'asc')
      .orderBy('createdAt', 'asc')
      .limit(deps.limit ?? 200)
      .forUpdate()
      .execute();
    return gradeHiddenVotes(trx, due, { now, settings });
  });

  for (const outcome of outcomes) metrics.hiddenCheckGraded(outcome.verdict);
  await mirrorXp(deps.mirrorXp, xp);
  let resets = 0;
  for (const playerId of resetFor) if (await resetNow(playerId, deps)) resets++;
  return {
    graded: outcomes.length,
    failed: outcomes.filter((o) => o.verdict === 'failed').length,
    resets,
  };
}
