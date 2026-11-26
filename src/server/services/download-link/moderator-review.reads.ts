import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

/** Flagged for moderator review (model or version), kept in `meta` rather than in `status`. */
export async function readModeratorFlags(
  db: Kysely<DB>,
  modelVersionId: number
): Promise<{ inReview: boolean }> {
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
  return { inReview: !!row?.inReview };
}
