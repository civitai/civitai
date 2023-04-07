DROP VIEW "PostResourceHelper";

DROP VIEW "ImageResourceHelper";

DROP VIEW "ModelTag";

DROP VIEW "ImageTag";

-- AlterTable
ALTER TABLE
  "Model"
ALTER COLUMN
  "name"
SET
  DATA TYPE CITEXT;

-- AlterTable
drop view "ModelHash";

ALTER TABLE
  "ModelFileHash"
ALTER COLUMN
  "hash"
SET
  DATA TYPE CITEXT;

create view "ModelHash"(
  "modelId",
  "modelVersionId",
  "fileType",
  "hashType",
  hash
) as
SELECT
  m.id AS "modelId",
  mv.id AS "modelVersionId",
  mf.type AS "fileType",
  mh.type AS "hashType",
  mh.hash
FROM
  "Model" m
  JOIN "ModelVersion" mv ON mv."modelId" = m.id
  JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id
  JOIN "ModelFileHash" mh ON mh."fileId" = mf.id
WHERE
  mf.type = ANY (ARRAY ['Model'::text, 'Pruned Model'::text]);

-- AlterTable
ALTER TABLE
  "Question"
ALTER COLUMN
  "title"
SET
  DATA TYPE CITEXT;

-- AlterTable
ALTER TABLE
  "Tag"
ALTER COLUMN
  "name"
SET
  DATA TYPE CITEXT;

-- Create ImageResourceHelper View
CREATE
OR REPLACE VIEW "ImageResourceHelper" AS
SELECT
  ir.id "id",
  ir."imageId",
  rr.id "reviewId",
  rr.rating "reviewRating",
  rr.details "reviewDetails",
  rr."createdAt" "reviewCreatedAt",
  ir.name,
  mv.id "modelVersionId",
  mv.name "modelVersionName",
  mv."createdAt" "modelVersionCreatedAt",
  m.id "modelId",
  m.name "modelName",
  mr."ratingAllTime" "modelRating",
  mr."ratingCountAllTime" "modelRatingCount",
  mr."downloadCountAllTime" "modelDownloadCount",
  mr."commentCountAllTime" "modelCommentCount",
  mr."favoriteCountAllTime" "modelFavoriteCount",
  m.type "modelType",
  i."postId" "postId",
  i.hash
FROM
  "ImageResource" ir
  JOIN "Image" i ON i.id = ir."imageId"
  LEFT JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
  LEFT JOIN "Model" m ON m.id = mv."modelId"
  LEFT JOIN "ModelRank" mr ON mr."modelId" = m.id
  LEFT JOIN "ResourceReview" rr ON rr."modelVersionId" = mv.id
  AND rr."userId" = i."userId";

-- Create PostResourceHelper View
CREATE
OR REPLACE VIEW "PostResourceHelper" AS
SELECT
  DISTINCT ON ("postId", "name", "modelVersionId") *
FROM
  "ImageResourceHelper";

-- Add ModelTag view
CREATE
OR REPLACE VIEW "ModelTag" AS WITH model_tags AS (
  SELECT
    "modelId",
    "tagId",
    5 "score",
    -- Weight of creator selection
    1 "upVotes",
    0 "downVotes"
  FROM
    "TagsOnModels"
  UNION
  SELECT
    "modelId",
    "tagId",
    SUM(vote) "score",
    SUM(IIF(vote > 0, 1, 0)) "upVotes",
    SUM(IIF(vote < 0, 1, 0)) "downVotes"
  FROM
    "TagsOnModelsVote"
  GROUP BY
    "tagId",
    "modelId"
)
SELECT
  mt."modelId",
  mt."tagId",
  SUM(mt.score) "score",
  SUM("upVotes") "upVotes",
  SUM("downVotes") "downVotes",
  t.name "tagName",
  t.type "tagType"
FROM
  model_tags mt
  JOIN "Tag" t ON t.id = mt."tagId"
GROUP BY
  mt."modelId",
  mt."tagId",
  t.name,
  t.type;

-- Add ImageTag View
CREATE
OR REPLACE VIEW "ImageTag" AS WITH image_tags AS (
  SELECT
    "imageId",
    "tagId",
    automated,
    confidence,
    10 * confidence / 100 "score",
    0 "upVotes",
    0 "downVotes"
  FROM
    "TagsOnImage" toi
  WHERE
    NOT toi.disabled
  UNION
  SELECT
    "imageId",
    "tagId",
    FALSE "automated",
    0 "confidence",
    SUM(vote) "score",
    SUM(IIF(vote > 0, 1, 0)) "upVotes",
    SUM(IIF(vote < 0, 1, 0)) "downVotes"
  FROM
    "TagsOnImageVote"
  GROUP BY
    "tagId",
    "imageId"
)
SELECT
  it."imageId",
  it."tagId",
  BOOL_OR(it.automated) "automated",
  MAX(it.confidence) "confidence",
  SUM(score) "score",
  MAX("upVotes") "upVotes",
  MAX("downVotes") "downVotes",
  t.name "tagName",
  t.type "tagType"
FROM
  image_tags it
  JOIN "Tag" t ON t.id = it."tagId"
GROUP BY
  it."imageId",
  it."tagId",
  t.name,
  t.type;

-- CreateIndex
CREATE INDEX "Account_provider_userId_idx" ON "Account"("provider", "userId");

-- CreateIndex
CREATE INDEX "Model_name_idx" ON "Model"("name" text_pattern_ops);

-- CreateIndex
CREATE INDEX "Model_status_nsfw_idx" ON "Model"("status", "nsfw");

-- CreateIndex
CREATE INDEX "ModelFileHash_hash_idx" ON "ModelFileHash" USING HASH ("hash");

-- CreateIndex
CREATE INDEX "UserActivity_createdAt_idx" ON "UserActivity"("createdAt");

-- CreateIndex
CREATE INDEX "TagsOnImage_automated_idx" ON "TagsOnImage" ("automated");
