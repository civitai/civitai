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
    WHERE mv."modelId" = ${modelId} AND p."userId" = ${userId} AND i.type::text = 'image'
    LIMIT ${sql.raw(String(cap))}
  ) capped`;

/** A model's first `limit` cover images, as a subquery to alias `c`, ordered by `MODEL_COVER_ORDER`.
 *  The outer LIMIT has no ORDER BY on purpose: one would force a full read of every post's images;
 *  the lateral join already emits in sorted post order. */
export const modelCoverImages = (
  modelId: RawBuilder<unknown>,
  userId: RawBuilder<unknown>,
  limit: number
) => sql`
  -- Unpublishing a model clears its posts' publishedAt, so filtering on it would show an
  -- unpublished or draft model with no images at all.
  SELECT i.id, i.url, i."nsfwLevel", pp.unpublished, pp."versionIndex", pp."postId",
         i.index AS "imageIndex"
  FROM (
    SELECT p.id AS "postId", p."publishedAt" IS NULL AS unpublished, mv.index AS "versionIndex"
    FROM "ModelVersion" mv
    JOIN "Post" p ON p."modelVersionId" = mv.id
    WHERE mv."modelId" = ${modelId} AND p."userId" = ${userId}
    ORDER BY unpublished, mv.index ASC NULLS LAST, p.id ASC
  ) pp
  CROSS JOIN LATERAL (
    SELECT i.id, i.url, i."nsfwLevel", i.index
    FROM "Image" i
    WHERE i."postId" = pp."postId" AND i.type::text = 'image'
    ORDER BY i.index ASC NULLS LAST, i.id ASC
    LIMIT ${sql.raw(String(limit))}
  ) i
  LIMIT ${sql.raw(String(limit))}`;
