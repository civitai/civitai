import { sql, type Transaction } from 'kysely';
import { REFERENCE_POOL, REFERENCE_SOURCE, REFERENCE_STATUS } from '@civitai/db/knights';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';
import { metrics } from '../metrics';
import { skillCheckEligible } from './eligible';

/** Serialises adds, so concurrent confirmations cannot leave the pool over its cap or retire two checks for one. */
const POOL_LOCK_NAMESPACE = 7_310;
const POOL_LOCK_KEY = 1;

export type AddSkillCheckResult = 'added' | 'moved' | 'kept-core' | 'ineligible';

/**
 * Puts an image two moderators confirmed into the skill-check pool at their level, then retires the oldest active checks
 * past `cap`. An image already in another pool moves here with its counters reset (one known answer per image); a core
 * trial image never moves. Runs in the caller's transaction.
 */
export async function addSkillCheck(
  trx: Transaction<DB>,
  { imageId, answer, cap, now }: { imageId: number; answer: string; cap: number; now: Date }
): Promise<AddSkillCheckResult> {
  await sql`SELECT pg_advisory_xact_lock(${POOL_LOCK_NAMESPACE}, ${POOL_LOCK_KEY})`.execute(trx);

  const existing = await trx
    .selectFrom('KnightsReferenceImage')
    .select(['id', 'source'])
    .where('imageId', '=', imageId)
    .forUpdate()
    .executeTakeFirst();
  if (existing?.source === REFERENCE_SOURCE.core) return 'kept-core';

  const eligible = await trx
    .selectFrom('Image as img')
    .innerJoin('Post as p', 'p.id', 'img.postId')
    .select('img.id')
    .where('img.id', '=', imageId)
    .where(skillCheckEligible)
    .executeTakeFirst();
  if (!eligible) return 'ineligible';

  const at = utc(now);
  const fields = {
    pool: REFERENCE_POOL.skillCheck,
    source: REFERENCE_SOURCE.inquisitor,
    status: REFERENCE_STATUS.active,
    answer,
    harvestedAt: at,
    updatedAt: at,
  };
  if (existing) {
    await trx
      .updateTable('KnightsReferenceImage')
      .set({ ...fields, answers: 0, failures: 0, modActivityId: null, explanation: null })
      .where('id', '=', existing.id)
      .execute();
  } else {
    await trx
      .insertInto('KnightsReferenceImage')
      .values({ ...fields, imageId, questionKey: KNIGHTS_NSFW_LEVEL_QUESTION, createdAt: at })
      .execute();
  }

  const overflow = await trx
    .updateTable('KnightsReferenceImage')
    .set({ status: REFERENCE_STATUS.retired, updatedAt: at })
    .where(
      'id',
      'in',
      trx
        .selectFrom('KnightsReferenceImage')
        .select('id')
        .where('pool', '=', REFERENCE_POOL.skillCheck)
        .where('status', '=', REFERENCE_STATUS.active)
        .orderBy('harvestedAt', 'desc')
        .orderBy('id', 'desc')
        .offset(cap)
    )
    .executeTakeFirst();
  metrics.skillChecksRetired('cap', Number(overflow.numUpdatedRows));

  return existing ? 'moved' : 'added';
}
