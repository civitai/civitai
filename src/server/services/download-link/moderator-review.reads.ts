import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

/** Whether the model or the version is flagged for moderator review. */
export async function readInModeratorReview(
  db: Kysely<DB>,
  modelVersionId: number
): Promise<boolean> {
  const row = await db
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .select(({ ref }) => [
      sql<boolean>`coalesce(${ref('m.meta')}->>'needsReview' = 'true', false) or coalesce(${ref(
        'mv.meta'
      )}->>'needsReview' = 'true', false)`.as('inReview'),
    ])
    .where('mv.id', '=', modelVersionId)
    .executeTakeFirst();
  return !!row?.inReview;
}
