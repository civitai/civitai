import { sql, type Kysely } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { REFERENCE_POOL, REFERENCE_SOURCE, REFERENCE_STATUS } from '@civitai/db/knights';
import { MODERATOR_QUEUE_RATING_REASON } from './harvest.service';

/** A harvested hidden check stays only once this many players answered it and most of them gave its answer. */
export const KEEP_MIN_PLAYERS = 5;

type Executor = Kysely<DB>;

/** Harvested hidden checks whose players' answers agree with the ruling; a hidden check votes under -referenceId. */
function agreed(db: Executor, excludeImageIds: number[]) {
  return db
    .selectFrom('KnightsReferenceImage as k')
    .innerJoin('KnightsVote as v', (join) => join.on(sql<boolean>`"v"."itemId" = -"k"."id"`))
    .innerJoin('Image as img', 'img.id', 'k.imageId')
    .select('k.id')
    .where('k.pool', '=', REFERENCE_POOL.hiddenCheck)
    .where('k.source', '=', REFERENCE_SOURCE.harvested)
    .where(
      sql<boolean>`"img"."metadata"->>'nsfwLevelReason' IS DISTINCT FROM ${MODERATOR_QUEUE_RATING_REASON}`
    )
    .$if(excludeImageIds.length > 0, (qb) => qb.where('k.imageId', 'not in', excludeImageIds))
    .groupBy(['k.id', 'k.answer'])
    .having(sql<boolean>`count(DISTINCT "v"."playerId") >= ${KEEP_MIN_PLAYERS}`)
    .having(
      sql<boolean>`2 * count(DISTINCT "v"."playerId") FILTER (WHERE "v"."answer" = "k"."answer") > count(DISTINCT "v"."playerId")`
    );
}

const LIVE = [REFERENCE_STATUS.active, REFERENCE_STATUS.pending];

/** The status-only update that retires every live harvested hidden check outside the agreed set. Never deletes. */
export function retireUnagreedQuery(db: Executor, { now, excludeImageIds }: RebuildInput) {
  return db
    .updateTable('KnightsReferenceImage')
    .set({ status: REFERENCE_STATUS.retired, updatedAt: utc(now) })
    .where('pool', '=', REFERENCE_POOL.hiddenCheck)
    .where('source', '=', REFERENCE_SOURCE.harvested)
    .where('status', 'in', LIVE)
    .where('id', 'not in', agreed(db, excludeImageIds));
}

export type RebuildInput = { now: Date; excludeImageIds: number[] };
export type RebuildCounts = { live: number; keep: number; retire: number };

/** How a run would split the live harvested hidden checks. Reads only. */
export async function planHiddenRebuild(
  db: Executor,
  { excludeImageIds }: Pick<RebuildInput, 'excludeImageIds'>
): Promise<RebuildCounts> {
  const row = await db
    .selectFrom('KnightsReferenceImage as r')
    .select((eb) => [
      eb.fn.countAll<string>().as('live'),
      eb.fn.count<string>('r.id').filterWhere('r.id', 'in', agreed(db, excludeImageIds)).as('keep'),
    ])
    .where('r.pool', '=', REFERENCE_POOL.hiddenCheck)
    .where('r.source', '=', REFERENCE_SOURCE.harvested)
    .where('r.status', 'in', LIVE)
    .executeTakeFirstOrThrow();
  const live = Number(row.live);
  const keep = Number(row.keep);
  return { live, keep, retire: live - keep };
}

/**
 * Retires the live harvested hidden checks players do not agree with, plus `excludeImageIds`, in one transaction.
 * Safe to re-run: a second run with the same votes retires nothing more.
 */
export async function retireUnagreedHiddenChecks(db: Executor, input: RebuildInput) {
  return db.transaction().execute(async (trx) => {
    const before = await planHiddenRebuild(trx, input);
    const result = await retireUnagreedQuery(trx, input).executeTakeFirst();
    const retired = Number(result.numUpdatedRows);
    if (retired !== before.retire) {
      throw new Error(
        `Expected to retire ${before.retire} hidden checks, the update matched ${retired}.`
      );
    }
    return { before, retired, after: await planHiddenRebuild(trx, input) };
  });
}
