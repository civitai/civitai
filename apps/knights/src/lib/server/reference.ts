import type { Kysely, Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { REFERENCE_POOL, REFERENCE_STATUS, servableImage } from '@civitai/db/knights';

type Pool = (typeof REFERENCE_POOL)[keyof typeof REFERENCE_POOL];
export type ServedStatus = typeof REFERENCE_STATUS.active | typeof REFERENCE_STATUS.probation;

/**
 * Reference images of one pool, in `statuses` (active by default), whose image the public feeds would show. The
 * apprenticeship and hidden checks both read through this.
 */
export function servableReferences(
  db: Kysely<DB> | Transaction<DB>,
  pool: Pool,
  statuses: ServedStatus[] = [REFERENCE_STATUS.active]
) {
  return db
    .selectFrom('KnightsReferenceImage as r')
    .innerJoin('Image as img', 'img.id', 'r.imageId')
    .innerJoin('Post as p', 'p.id', 'img.postId')
    .where('r.pool', '=', pool)
    .where('r.status', 'in', statuses)
    .where(servableImage);
}
