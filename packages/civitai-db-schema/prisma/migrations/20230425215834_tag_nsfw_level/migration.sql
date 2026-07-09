-- AlterTable
ALTER TABLE "Tag" ADD COLUMN     "nsfw" "NsfwLevel" NOT NULL DEFAULT 'None';

-- Set nsfw level for tags
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
)
UPDATE "Tag" t SET nsfw = tl.level
FROM tag_level tl
WHERE tl."tagId" = t.id;

-- Update image tag view
drop view if exists "ImageTag";
create or replace view "ImageTag" as
WITH image_tags AS (
	SELECT
    toi."imageId",
    toi."tagId",
    toi.automated,
    toi.confidence,
    10 * toi.confidence / 100 AS score,
    0 AS "upVotes",
    0 AS "downVotes",
    toi."needsReview"
  FROM "TagsOnImage" toi
  WHERE NOT toi.disabled
  UNION
  SELECT
    "TagsOnImageVote"."imageId",
    "TagsOnImageVote"."tagId",
    FALSE AS automated,
    0 AS confidence,
    SUM("TagsOnImageVote".vote) AS score,
    SUM(iif("TagsOnImageVote".vote > 0, 1, 0)) AS "upVotes",
    SUM(iif("TagsOnImageVote".vote < 0, 1, 0)) AS "downVotes",
    FALSE AS "needReview"
  FROM "TagsOnImageVote"
  GROUP BY "TagsOnImageVote"."tagId", "TagsOnImageVote"."imageId"
)
SELECT
	it."imageId",
	it."tagId",
	BOOL_OR(it.automated) AS automated,
	MAX(it.confidence) AS confidence,
	COALESCE(SUM(it.score), 0::numeric) AS score,
	MAX(it."upVotes") AS "upVotes",
	MAX(it."downVotes") AS "downVotes",
	t.name AS "tagName",
	t.type AS "tagType",
	t.nsfw AS "tagNsfw",
	BOOL_OR(it."needsReview") AS "needsReview"
FROM image_tags it
JOIN "Tag" t ON t.id = it."tagId" AND NOT t.unlisted
GROUP BY it."imageId", it."tagId", t.name, t.type, t.nsfw;

-- Drop rating tags
DELETE FROM "Tag" WHERE type = 'System' AND name IN ('rated 13+', 'rated m', 'rated x');