-- update_nsfw_levels_new: a tag recompute never takes an unlocked image below the level a collection
-- judge recorded in metadata.judgeRating (written by setCollectionItemNsfwLevel). Rows without a
-- judge rating get the level they got before. On every row, a recompute that flags a minor keeps an
-- existing csam or appeal review instead of replacing it with minor. Mirrors
-- programmability/update_nsfw_level.sql.
CREATE OR REPLACE FUNCTION update_nsfw_levels_new(image_ids INTEGER[])
RETURNS VOID AS $$
BEGIN
  WITH image_level AS (
    SELECT
      toi."imageId",
      CASE
        WHEN bool_or(t."nsfwLevel" = 32) THEN 32
        WHEN bool_or(t."nsfwLevel" = 16) THEN 16
        WHEN bool_or(t."nsfwLevel" = 8) THEN 8
        WHEN bool_or(t."nsfwLevel" = 4) THEN 4
        WHEN bool_or(t."nsfwLevel" = 2) THEN 2
        ELSE 1
      END "nsfwLevel"
    FROM "TagsOnImageDetails" toi
    LEFT JOIN "Tag" t ON t.id = toi."tagId" AND t."nsfwLevel" > 1
    WHERE toi."imageId" = ANY(image_ids) AND NOT toi."disabled"
    GROUP BY toi."imageId"
  ), floored AS (
    SELECT
      il."imageId",
      GREATEST(
        il."nsfwLevel",
        CASE
          WHEN jsonb_typeof(i."metadata" -> 'judgeRating' -> 'nsfwLevel') = 'number'
            AND (i."metadata" -> 'judgeRating' -> 'nsfwLevel')::text IN ('1', '2', '4', '8', '16')
          THEN (i."metadata" -> 'judgeRating' -> 'nsfwLevel')::text::int
          ELSE 0
        END
      ) "nsfwLevel"
    FROM image_level il
    JOIN "Image" i ON i.id = il."imageId"
  )
  UPDATE "Image" i SET
    "nsfwLevel" = f."nsfwLevel",
    "needsReview" = CASE
      WHEN i."needsReview" IN ('csam', 'appeal') THEN i."needsReview"
      WHEN (i."scanJobs"->'hasMinor')::boolean AND f."nsfwLevel" > 1 AND f."nsfwLevel" < 32
        THEN 'minor'
        ELSE i."needsReview"
      END
  FROM floored f
  WHERE f."imageId" = i.id AND NOT i."nsfwLevelLocked" AND f."nsfwLevel" != i."nsfwLevel" AND i.ingestion = 'Scanned' AND "blockedFor" IS NULL;
END;
$$ LANGUAGE plpgsql;
