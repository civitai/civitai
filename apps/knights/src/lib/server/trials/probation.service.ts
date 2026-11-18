import { sql, type Kysely, type SqlBool } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { REFERENCE_POOL, REFERENCE_SOURCE, REFERENCE_STATUS } from '@civitai/db/knights';
import { KEEP_MIN_PLAYERS, majorityAgrees } from './hidden-rebuild.service';

/** Sources whose references players' answers never promote or retire: core is curated by moderators. */
export const EXEMPT_SOURCES: string[] = [REFERENCE_SOURCE.core];

export type ProbationReview = { promoted: number; retired: number };

/**
 * Probation checks answered by at least `KEEP_MIN_PLAYERS` distinct players, and whether most of them gave the
 * reference's answer. A player who also voted on the image outside the check (the queue item a probation reference
 * came from) is not counted: a verdict cannot confirm itself.
 */
function tallies(db: Kysely<DB>) {
  return (
    db
      .selectFrom('KnightsReferenceImage as k')
      .innerJoin('KnightsVote as v', (join) => join.on(sql<SqlBool>`"v"."itemId" = -"k"."id"`))
      .select(['k.id'])
      .where('k.pool', '=', REFERENCE_POOL.hiddenCheck)
      // A held player's vote carries no weight in any verdict, so none here either.
      .where('v.weight', '>', 0)
      .where('k.status', '=', REFERENCE_STATUS.probation)
      .where('k.source', 'not in', EXEMPT_SOURCES)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('KnightsVote as own')
              .select(sql<number>`1`.as('one'))
              .whereRef('own.playerId', '=', 'v.playerId')
              .whereRef('own.imageId', '=', 'k.imageId')
              .whereRef('own.questionKey', '=', 'k.questionKey')
              .where('own.itemId', '>', 0)
          )
        )
      )
      .groupBy(['k.id', 'k.answer'])
      .having(sql<SqlBool>`count(DISTINCT "v"."playerId") >= ${KEEP_MIN_PLAYERS}`)
      .select(majorityAgrees.as('agreed'))
  );
}

/**
 * Settles probation by the answers it collected: a probation check most of its players answered exactly as its
 * reference does becomes active, any other is retired, and one with too few players is left alone. Active checks are
 * not reviewed here; they keep the failure-rate retirement in `gradeHiddenVotes`. Runs whether or not the harvest is
 * paused.
 */
export async function reviewProbation(
  db: Kysely<DB>,
  { now }: { now: Date }
): Promise<ProbationReview> {
  return db.transaction().execute(async (trx) => {
    const rows = await tallies(trx as unknown as Kysely<DB>).execute();
    const set = async (ids: number[], status: string) => {
      if (ids.length === 0) return 0;
      const result = await trx
        .updateTable('KnightsReferenceImage')
        .set({ status, updatedAt: utc(now) })
        .where('id', 'in', ids)
        .where('status', '=', REFERENCE_STATUS.probation)
        .where('source', 'not in', EXEMPT_SOURCES)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    };
    return {
      promoted: await set(
        rows.filter((r) => r.agreed).map((r) => r.id),
        REFERENCE_STATUS.active
      ),
      retired: await set(
        rows.filter((r) => !r.agreed).map((r) => r.id),
        REFERENCE_STATUS.retired
      ),
    };
  });
}
