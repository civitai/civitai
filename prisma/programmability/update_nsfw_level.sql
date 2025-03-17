CREATE OR REPLACE FUNCTION update_nsfw_levels(image_ids INTEGER[])
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
    FROM "TagsOnImage" toi
    LEFT JOIN "Tag" t ON t.id = toi."tagId" AND t."nsfwLevel" > 1
    WHERE toi."imageId" = ANY(image_ids) AND toi."disabledAt" IS NULL
    GROUP BY toi."imageId"
  )
  UPDATE "Image" i SET
    "nsfwLevel" = il."nsfwLevel",
    "needsReview" = CASE
      WHEN (i."scanJobs"->'hasMinor')::boolean AND il."nsfwLevel" > 1 AND il."nsfwLevel" < 32
        THEN 'minor'
        ELSE i."needsReview"
      END
  FROM image_level il
  WHERE il."imageId" = i.id AND NOT i."nsfwLevelLocked" AND il."nsfwLevel" != i."nsfwLevel" AND i.ingestion = 'Scanned' AND "blockedFor" IS NULL;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE FUNCTION update_nsfw_level(VARIADIC image_ids INTEGER[])
RETURNS VOID AS $$
BEGIN
	PERFORM update_nsfw_levels(image_ids);
END;
$$ LANGUAGE plpgsql;


-- new function so that the transition to using "TagsOnImageNew" can be seemless on deployement
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
  )
  UPDATE "Image" i SET
    "nsfwLevel" = il."nsfwLevel",
    "needsReview" = CASE
      WHEN (i."scanJobs"->'hasMinor')::boolean AND il."nsfwLevel" > 1 AND il."nsfwLevel" < 32
        THEN 'minor'
        ELSE i."needsReview"
      END
  FROM image_level il
  WHERE il."imageId" = i.id AND NOT i."nsfwLevelLocked" AND il."nsfwLevel" != i."nsfwLevel" AND i.ingestion = 'Scanned' AND "blockedFor" IS NULL;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE FUNCTION update_nsfw_level_new(VARIADIC image_ids INTEGER[])
RETURNS VOID AS $$
BEGIN
	PERFORM update_nsfw_levels_new(image_ids);
END;
$$ LANGUAGE plpgsql;