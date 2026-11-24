import type { Kysely, Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { REFERENCE_POOL, REFERENCE_STATUS, servableImage } from '@civitai/db/knights';
import { skillCheckEligible } from './skill-check/eligible';

export type Pool = (typeof REFERENCE_POOL)[keyof typeof REFERENCE_POOL];
export type ServedStatus = typeof REFERENCE_STATUS.active | typeof REFERENCE_STATUS.probation;

/**
 * Reference images of the given pools, in `statuses` (active by default), whose image the public feeds would show. A
 * mod-confirmed skill check also needs its image free of any review or hold (`skillCheckEligible`), checked on every
 * read. The apprenticeship and hidden checks both read through this.
 */
export function servableReferences(
  db: Kysely<DB> | Transaction<DB>,
  pools: readonly Pool[],
  statuses: ServedStatus[] = [REFERENCE_STATUS.active]
) {
  return db
    .selectFrom('KnightsReferenceImage as r')
    .innerJoin('Image as img', 'img.id', 'r.imageId')
    .innerJoin('Post as p', 'p.id', 'img.postId')
    .where('r.pool', 'in', pools)
    .where('r.status', 'in', statuses)
    .where((eb) =>
      pools.includes(REFERENCE_POOL.skillCheck)
        ? eb.or([
            eb.and([eb('r.pool', '!=', REFERENCE_POOL.skillCheck), servableImage(eb)]),
            eb.and([eb('r.pool', '=', REFERENCE_POOL.skillCheck), skillCheckEligible(eb)]),
          ])
        : servableImage(eb)
    );
}
