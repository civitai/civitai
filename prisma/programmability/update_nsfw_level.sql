CREATE OR REPLACE FUNCTION update_nsfw_levels(image_ids INTEGER[])
RETURNS VOID AS $$
BEGIN
  WITH image_level AS (
    SELECT
      toi."imageId",
      CASE
        WHEN bool_or(t.nsfw = 'X') THEN 'X'::"NsfwLevel"
        WHEN bool_or(t.nsfw = 'Mature') THEN 'Mature'::"NsfwLevel"
        WHEN bool_or(t.nsfw = 'Soft') THEN 'Soft'::"NsfwLevel"
        ELSE 'None'::"NsfwLevel"
      END "nsfw",
      CASE
        WHEN bool_or(t."nsfwLevel" = 32) THEN 32
        WHEN bool_or(t."nsfwLevel" = 16) THEN 16
        WHEN bool_or(t."nsfwLevel" = 8) THEN 8
        WHEN bool_or(t."nsfwLevel" = 4) THEN 4
        WHEN bool_or(t."nsfwLevel" = 2) THEN 2
        ELSE 1
      END "nsfwLevel"
    FROM "TagsOnImage" toi
    LEFT JOIN "Tag" t ON t.id = toi."tagId" AND (t.nsfw != 'None' OR t."nsfwLevel" > 1)
    WHERE toi."imageId" = ANY(image_ids) AND NOT toi.disabled
    GROUP BY toi."imageId"
  )
  UPDATE "Image" i SET nsfw = il.nsfw, "nsfwLevel" = il."nsfwLevel"
  FROM image_level il
  WHERE il."imageId" = i.id AND NOT i."nsfwLevelLocked" AND (il."nsfwLevel" != i."nsfwLevel" OR il.nsfw != i.nsfw) AND i.ingestion = 'Scanned' AND i."nsfwLevel" != 32;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE FUNCTION update_nsfw_level(VARIADIC image_ids INTEGER[])
RETURNS VOID AS $$
BEGIN
	PERFORM update_nsfw_levels(image_ids);
END;
$$ LANGUAGE plpgsql;
