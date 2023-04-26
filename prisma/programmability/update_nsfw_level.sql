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
      END "nsfw"
    FROM "TagsOnImage" toi
    JOIN "Tag" t ON t.id = toi."tagId" AND t.nsfw != 'None'
    WHERE toi."imageId" = ANY(image_ids) AND NOT toi.disabled
    GROUP BY toi."imageId"
  )
  UPDATE "Image" i SET nsfw = il.nsfw
  FROM image_level il
  WHERE il."imageId" = i.id;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE FUNCTION update_nsfw_level(VARIADIC image_ids INTEGER[])
RETURNS VOID AS $$
BEGIN
	PERFORM update_nsfw_levels(image_ids);
END;
$$ LANGUAGE plpgsql;