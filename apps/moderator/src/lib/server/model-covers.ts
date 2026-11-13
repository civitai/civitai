import { sql, type RawBuilder } from '@civitai/db/kysely';

export const MODEL_COVER_ORDER = sql`c.unpublished, c."versionIndex" ASC NULLS LAST, c."postId",
  c."imageIndex" ASC NULLS LAST, c.id`;

export const modelCoverCount = (
  modelId: RawBuilder<unknown>,
  userId: RawBuilder<unknown>,
  cap: number
) => sql`
  SELECT count(*)::int AS total
  FROM (
    SELECT 1
    FROM "ModelVersion" mv
    JOIN "Post" p ON p."modelVersionId" = mv.id
    JOIN "Image" i ON i."postId" = p.id
    WHERE mv."modelId" = ${modelId} AND p."userId" = ${userId} AND i.type::text IN ('image', 'video')
    LIMIT ${sql.raw(String(cap))}
  ) capped`;

/** A model's first `limit` cover images and videos, as a subquery to alias `c`, ordered by `MODEL_COVER_ORDER`.
 *  The outer ORDER BY leads with `pp`'s own sort keys, so Postgres runs it as an incremental sort and
 *  still stops after the first posts; reorder those keys and it reads every post's images. */
export const modelCoverImages = (
  modelId: RawBuilder<unknown>,
  userId: RawBuilder<unknown>,
  limit: number
) => sql`
  -- Unpublishing a model clears its posts' publishedAt, so filtering on it would show an
  -- unpublished or draft model with no images at all.
  SELECT i.id, i.url, i."nsfwLevel", i.type::text AS type, i.minor, i."acceptableMinor",
         pp.unpublished, pp."versionIndex", pp."postId", i.index AS "imageIndex"
  FROM (
    SELECT p.id AS "postId", p."publishedAt" IS NULL AS unpublished, mv.index AS "versionIndex"
    FROM "ModelVersion" mv
    JOIN "Post" p ON p."modelVersionId" = mv.id
    WHERE mv."modelId" = ${modelId} AND p."userId" = ${userId}
    ORDER BY unpublished, mv.index ASC NULLS LAST, p.id ASC
  ) pp
  CROSS JOIN LATERAL (
    SELECT i.id, i.url, i."nsfwLevel", i.type, i.minor, i."acceptableMinor", i.index
    FROM "Image" i
    WHERE i."postId" = pp."postId" AND i.type::text IN ('image', 'video')
    ORDER BY i.index ASC NULLS LAST, i.id ASC
    LIMIT ${sql.raw(String(limit))}
  ) i
  ORDER BY pp.unpublished, pp."versionIndex" ASC NULLS LAST, pp."postId", i.index ASC NULLS LAST, i.id
  LIMIT ${sql.raw(String(limit))}`;
