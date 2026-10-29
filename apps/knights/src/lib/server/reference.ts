import type { Kysely, Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { REFERENCE_POOL, REFERENCE_STATUS, servableImage } from '@civitai/db/knights';

type Pool = (typeof REFERENCE_POOL)[keyof typeof REFERENCE_POOL];

/** Active reference images of one pool whose image the public feeds would show. Trials and hidden checks both read through this. */
export function servableReferences(db: Kysely<DB> | Transaction<DB>, pool: Pool) {
  return db
    .selectFrom('KnightsReferenceImage as r')
    .innerJoin('Image as img', 'img.id', 'r.imageId')
    .innerJoin('Post as p', 'p.id', 'img.postId')
    .where('r.pool', '=', pool)
    .where('r.status', '=', REFERENCE_STATUS.active)
    .where(servableImage);
}
