import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

/**
 * Moderation flags kept in `meta` rather than in `status`: flagged for moderator review (model or
 * version), and a model kept after its owner's content was removed (a kept draft stays `Draft`).
 */
export async function readModeratorFlags(
  db: Kysely<DB>,
  modelVersionId: number
): Promise<{ inReview: boolean; removedWithOwner: boolean }> {
  const row = await db
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .select(({ ref }) => [
      sql<boolean>`coalesce(${ref('m.meta')}->>'needsReview' = 'true', false) or coalesce(${ref(
        'mv.meta'
      )}->>'needsReview' = 'true', false)`.as('inReview'),
      sql<boolean>`coalesce(${ref('m.meta')}->>'removedWithOwner' = 'true', false)`.as(
        'removedWithOwner'
      ),
    ])
    .where('mv.id', '=', modelVersionId)
    .executeTakeFirst();
  return { inReview: !!row?.inReview, removedWithOwner: !!row?.removedWithOwner };
}
