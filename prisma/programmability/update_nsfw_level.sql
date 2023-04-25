CREATE OR REPLACE FUNCTION update_nsfw_levels(image_ids INTEGER[])
RETURNS VOID AS $$
BEGIN
  WITH tag_level AS (
    SELECT
      tot."toTagId" "tagId",
      CASE
        WHEN t.name = 'rated 13+' THEN 'Soft'::"NsfwLevel"
        WHEN t.name = 'rated m' THEN 'Mature'::"NsfwLevel"
        WHEN t.name = 'rated x' THEN 'X'::"NsfwLevel"
        ELSE 'None'::"NsfwLevel"
      END "level"
    FROM "TagsOnTags" tot
    JOIN "Tag" t ON t.id = tot."fromTagId"
    WHERE t.type = 'System' AND t.name IN ('rated 13+', 'rated m', 'rated x')
  ), image_level AS (
    SELECT
      toi."imageId",
      CASE
        WHEN bool_or(tl.level = 'X') THEN 'X'::"NsfwLevel"
        WHEN bool_or(tl.level = 'Mature') THEN 'Mature'::"NsfwLevel"
        WHEN bool_or(tl.level = 'Soft') THEN 'Soft'::"NsfwLevel"
        ELSE 'None'::"NsfwLevel"
      END "nsfw"
    FROM "TagsOnImage" toi
    JOIN tag_level tl ON tl."tagId" = toi."tagId"
    WHERE toi."imageId" = ANY(image_ids)
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