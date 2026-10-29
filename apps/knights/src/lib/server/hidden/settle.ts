import { sql, type Kysely } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { mirrorXp, type XpMirror } from '../progression/legacy-exp';
import { payOutVotes, type GradedVote } from '../progression/progression';
import { SMITES } from '../smites/config';
import { issueSmite, resetNow, type ResetDeps } from '../smites/smites.service';
import type { HiddenCheckSettings } from './config';
import { isSevereUnderRating } from './hidden.service';
import { SMITE_REASON } from './notices';

type Due = GradedVote & { answer: string };

/**
 * Grades the hidden checks that have waited long enough, paying them like any settled vote (bulk XP and gold for a right
 * answer, nothing for a wrong one, and a right answer works smites off). A wrong answer costs a warning or a smite.
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

  const { graded, failed, xp, resetFor } = await db.transaction().execute(async (trx) => {
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
    if (due.length === 0) return { graded: 0, failed: 0, xp: [], resetFor: [] as number[] };

    const known = new Map(
      (
        await trx
          .selectFrom('KnightsReferenceImage')
          .select(['id', 'answer'])
          .where('id', 'in', [...new Set(due.map((v) => -v.itemId))])
          .execute()
      ).map((r) => [r.id, r.answer])
    );
    const gradedVotes = due.map((v) => {
      const answer = known.get(-v.itemId);
      return {
        ...v,
        verdict: answer === undefined ? 'inconclusive' : v.answer === answer ? 'correct' : 'failed',
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
      if (v.verdict !== 'inconclusive') {
        await trx
          .updateTable('KnightsReferenceImage')
          .set({
            answers: sql<number>`"answers" + 1`,
            failures: sql<number>`"failures" + ${v.verdict === 'failed' ? 1 : 0}`,
          })
          .where('id', '=', -v.itemId)
          .execute();
      }
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
    for (const v of gradedVotes) {
      const since = startAt.get(v.playerId);
      // A wrong answer from before the last career reset was wiped with it.
      if (v.verdict !== 'failed' || !since || v.createdAt < since) continue;

      const windowStart = new Date(
        Math.max(now.getTime() - settings.failureWindowHours * 3_600_000, since.getTime())
      );
      const { n } = await trx
        .selectFrom('KnightsVote')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('playerId', '=', v.playerId)
        .where('itemId', '<', 0)
        .where('consequence', 'is not', null)
        .where('settledAt', '>=', utc(windowStart))
        .executeTakeFirstOrThrow();
      const known_ = known.get(-v.itemId) as string;
      const smites =
        Number(n) >= 1 || isSevereUnderRating(v.answer, known_, settings.severeDistance);

      await trx
        .updateTable('KnightsVote')
        .set({ consequence: smites ? 'smite' : 'warning' })
        .where('itemId', '=', v.itemId)
        .where('playerId', '=', v.playerId)
        .where('createdAt', '=', utc(v.createdAt))
        .execute();
      if (smites) {
        const active = await issueSmite(trx, { playerId: v.playerId, reason: SMITE_REASON, now });
        if (active >= SMITES.max) resetFor.add(v.playerId);
      }
    }

    return {
      graded: gradedVotes.length,
      failed: gradedVotes.filter((v) => v.verdict === 'failed').length,
      xp: paid.xp,
      resetFor: [...resetFor],
    };
  });

  await mirrorXp(deps.mirrorXp, xp);
  let resets = 0;
  for (const playerId of resetFor) if (await resetNow(playerId, deps)) resets++;
  return { graded, failed, resets };
}
