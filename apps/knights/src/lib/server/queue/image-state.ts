import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import type { ImageState } from './resolution';

type Executor = Kysely<DB> | Transaction<DB>;

export const lockReasonSql = (metadata: 'metadata' | 'img.metadata') =>
  sql<string | null>`${sql.ref(metadata)}->>'nsfwLevelReason'`;

/** What `decideWriteback` and `moderatorRuling` read about an image; null when it is gone. */
export async function readImageState(db: Executor, imageId: number): Promise<ImageState | null> {
  const image = await db
    .selectFrom('Image')
    .select([
      'nsfwLevel',
      'nsfwLevelLocked as locked',
      'ingestion',
      'blockedFor',
      lockReasonSql('metadata').as('lockReason'),
    ])
    .where('id', '=', imageId)
    .executeTakeFirst();
  return image ?? null;
}
