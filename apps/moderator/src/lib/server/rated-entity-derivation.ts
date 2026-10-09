import type { Kysely, Transaction } from 'kysely';
import { sql } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  articleModerationFloorText,
  challengeDerivedNsfwLevel,
  ratedEntityContentNsfwLevelText,
  type DerivedNsfwEntityType,
} from '@civitai/shared/rated-entity-sql';
import { collectionRatingLevel } from '@civitai/shared/rating-review';

export async function computeArticleDerivedNsfwLevel(
  db: Kysely<DB> | Transaction<DB>,
  articleId: number
): Promise<number | null> {
  const result = await sql<{ derived: number | null }>`
    WITH level AS (
      SELECT
        a.id,
        GREATEST(
          COALESCE(max(cover."nsfwLevel"), 0),
          COALESCE(max(content_imgs."nsfwLevel"), 0)
        ) AS "nsfwLevel"
      FROM "Article" a
      LEFT JOIN "Image" cover
        ON a."coverId" = cover.id
        AND cover."ingestion" = 'Scanned'
      LEFT JOIN "ImageConnection" ic
        ON ic."entityId" = a.id
        AND ic."entityType" = 'Article'
      LEFT JOIN "Image" content_imgs
        ON ic."imageId" = content_imgs.id
        AND content_imgs."ingestion" = 'Scanned'
      WHERE a.id = ${articleId}
      GROUP BY a.id
    ),
    moderation_floor AS (
      SELECT a.id, ${sql.raw(articleModerationFloorText('a.id'))} AS "floor"
      FROM "Article" a
      WHERE a.id = ${articleId}
    )
    SELECT GREATEST(level."nsfwLevel", mf."floor") AS derived
    FROM level
    JOIN moderation_floor mf ON mf.id = level.id
  `.execute(db);

  if (result.rows.length === 0) return null;
  return result.rows[0]?.derived ?? 0;
}

export async function computeRatedEntityDerivedNsfwLevel(
  db: Kysely<DB> | Transaction<DB>,
  entityType: DerivedNsfwEntityType | 'Article' | 'Challenge' | 'Crucible' | 'Collection',
  entityId: number
): Promise<number | null> {
  if (entityType === 'Article') return computeArticleDerivedNsfwLevel(db, entityId);
  if (entityType === 'Crucible') {
    const row = await db
      .selectFrom('Crucible')
      .select('nsfwLevel')
      .where('id', '=', entityId)
      .executeTakeFirst();
    return row ? challengeDerivedNsfwLevel(row.nsfwLevel) : null;
  }
  if (entityType === 'Collection') {
    const row = await db
      .selectFrom('Collection')
      .select('nsfwLevel')
      .where('id', '=', entityId)
      .executeTakeFirst();
    return row ? collectionRatingLevel(row.nsfwLevel) : null;
  }
  if (entityType === 'Challenge') {
    const row = await db
      .selectFrom('Challenge')
      .select('allowedNsfwLevel')
      .where('id', '=', entityId)
      .executeTakeFirst();
    return row ? challengeDerivedNsfwLevel(row.allowedNsfwLevel) : null;
  }
  const result = await sql<{ derived: number }>`
    SELECT ${sql.raw(ratedEntityContentNsfwLevelText(entityType, 'e'))} AS derived
    FROM ${sql.table(entityType)} e
    WHERE e.id = ${entityId}
  `.execute(db);
  return result.rows[0]?.derived ?? null;
}
