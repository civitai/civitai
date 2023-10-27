-- CreateEnum
CREATE TYPE "TagSource" AS ENUM ('User', 'Rekognition', 'WD14');

-- AlterTable
ALTER TABLE "TagsOnImage" ADD COLUMN     "source" "TagSource" NOT NULL DEFAULT 'User';
UPDATE "TagsOnImage" SET source = 'Rekognition' WHERE automated = true;

-- CreateIndex
CREATE INDEX "TagsOnImage_source_idx" ON "TagsOnImage"("source");

-- Update ImageTag view
DROP view "ImageTag";
create view "ImageTag" AS
WITH image_tags AS (
	SELECT
		toi."imageId",
		toi."tagId",
		toi.automated,
		toi.confidence,
		10 * toi.confidence / 100 AS score,
		0 AS "upVotes",
		0 AS "downVotes",
		toi."needsReview",
		toi.disabled,
		NOT toi.disabled AS concrete,
		NULL::timestamp WITHOUT TIME ZONE AS "lastUpvote",
		toi.source
	FROM "TagsOnImage" toi
	UNION
	SELECT
		"TagsOnImageVote"."imageId",
		"TagsOnImageVote"."tagId",
		FALSE AS automated,
		0 AS confidence,
		SUM("TagsOnImageVote".vote) AS score,
		SUM(iif("TagsOnImageVote".vote > 0, 1, 0)) AS "upVotes",
		SUM(iif("TagsOnImageVote".vote < 0, 1, 0)) AS "downVotes",
		FALSE AS "needReview",
		FALSE AS disabled,
		FALSE AS concrete,
		MAX(iif("TagsOnImageVote".vote > 0, "TagsOnImageVote"."createdAt", NULL::timestamp WITHOUT TIME ZONE)) AS "lastUpvote",
		NULL as source
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
	BOOL_OR(it."needsReview") AS "needsReview",
	BOOL_OR(it.concrete) AS concrete,
	MAX(it."lastUpvote") AS "lastUpvote",
	COALESCE(MAX(it.source), 'User') AS source
FROM image_tags it
     JOIN "Tag" t ON t.id = it."tagId" AND NOT t.unlisted
GROUP BY it."imageId", it."tagId", t.name, t.type, t.nsfw
HAVING BOOL_OR(it.disabled) = FALSE;
