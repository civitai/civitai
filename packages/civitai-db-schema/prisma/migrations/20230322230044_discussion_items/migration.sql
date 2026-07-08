------------------------------------------
-- Update DDL
------------------------------------------
-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "metadata" JSONB;

-- AlterTable
ALTER TABLE "CommentV2" ADD COLUMN     "metadata" JSONB;

-- AlterTable
ALTER TABLE "ImageResource" ADD COLUMN     "hash" TEXT;

-- AlterTable
ALTER TABLE "ResourceReview" ADD COLUMN     "exclude" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "modelId" INTEGER,
ADD COLUMN     "nsfw" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tosViolation" BOOLEAN NOT NULL DEFAULT false;

UPDATE "ResourceReview" r SET "modelId" = mv."modelId"
FROM "ModelVersion" mv
WHERE mv.id = r."modelVersionId";

ALTER TABLE "ResourceReview" ALTER COLUMN "modelId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "metadata" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "modelId" INTEGER;

-- CreateTable
CREATE TABLE "ResourceReviewReaction" (
    "id" SERIAL NOT NULL,
    "reviewId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "reaction" "ReviewReactions" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResourceReviewReaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ResourceReviewReaction_reviewId_userId_reaction_key" ON "ResourceReviewReaction"("reviewId", "userId", "reaction");

-- AddForeignKey
ALTER TABLE "ResourceReview" ADD CONSTRAINT "ResourceReview_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceReviewReaction" ADD CONSTRAINT "ResourceReviewReaction_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "ResourceReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceReviewReaction" ADD CONSTRAINT "ResourceReviewReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE SET NULL ON UPDATE CASCADE;

------------------------------------------
-- Setup Views
------------------------------------------

-- Add ResourceReviewHelper
CREATE OR REPLACE VIEW "ResourceReviewHelper" AS
SELECT
rr.id "resourceReviewId",
COUNT(DISTINCT i.id) "imageCount"
FROM "ResourceReview" rr
JOIN "ImageResource" ir ON ir."modelVersionId" = rr."modelVersionId"
JOIN "Image" i ON i.id = ir."imageId" AND i."userId" = rr."userId"
WHERE ir."modelVersionId" = rr."modelVersionId"
GROUP BY rr.id;

------------------------------------------
-- Posts Migration
------------------------------------------
-- Migrate ImagesOnModels
BEGIN;
-- Create posts for every model version
INSERT INTO "Post"("nsfw", "title", "userId", "modelVersionId", "createdAt", "updatedAt", "publishedAt", "metadata")
SELECT
  m.nsfw,
  mv.id "title",
  m."userId",
  mv.id "modelVersionId",
  mv."createdAt",
  mv."updatedAt",
  IIF(m.status = 'Published', GREATEST(mv."createdAt", m."publishedAt"), NULL) "publishedAt",
  JSONB_BUILD_OBJECT('modelId', m.id) "metadata"
FROM "ModelVersion" mv
JOIN "Model" m ON m.id = mv."modelId"
LEFT JOIN (
  SELECT "modelVersionId", COUNT(*) count
  FROM "ImagesOnModels"
  GROUP BY "modelVersionId"
) iom ON iom."modelVersionId" = mv.id
WHERE iom.count > 0;

-- Attach images on models to associated posts
WITH matching_rows AS (
  SELECT
    i.id AS image_id,
    p.id AS post_id
  FROM "ImagesOnModels" iom
  JOIN "Image" i ON iom."imageId" = i.id
  JOIN "Post" p ON p.title = iom."modelVersionId"::text
)
UPDATE "Image" img
SET "postId" = matching_rows.post_id
FROM matching_rows
WHERE img.id = matching_rows.image_id;

-- Migrate tags from the models to posts
INSERT INTO "TagsOnPost"("postId","tagId","createdAt")
SELECT
  p.id post_id,
  t.id tag_id,
	tom."createdAt"
FROM "TagsOnModels" tom
JOIN "ModelVersion" mv ON mv."modelId" = tom."modelId"
JOIN "Post" p ON p.title = mv.id::text
JOIN "Tag" t ON tom."tagId" = t.id
WHERE t."isCategory"
ON CONFLICT ("postId", "tagId") DO NOTHING;

-- Remove tags in excess of 5
WITH ranked_tags AS (
  SELECT
    "postId",
    "tagId",
    "createdAt",
    ROW_NUMBER() OVER (PARTITION BY "postId" ORDER BY "createdAt" DESC) AS row_num
  FROM "TagsOnPost"
)
DELETE FROM "TagsOnPost"
WHERE ("postId", "tagId") IN (
  SELECT "postId", "tagId"
  FROM ranked_tags
  WHERE row_num > 5
);

-- Remove temp post names
UPDATE "Post" p SET title = null
FROM "ModelVersion" mv
WHERE mv.id::text = p.title;
COMMIT;

-- Migrate ImagesOnReviews
BEGIN;
-- Create posts for every review
INSERT INTO "Post"("nsfw", "title", "userId", "modelVersionId", "createdAt", "updatedAt", "publishedAt", "metadata")
SELECT
  r.nsfw,
  CONCAT('r-',r.id) "title",
  r."userId",
  r."modelVersionId" "modelVersionId",
  r."createdAt",
  r."updatedAt",
  r."createdAt" "publishedAt",
  JSONB_BUILD_OBJECT('reviewId', r.id) "metadata"
FROM "Review" r
JOIN "Model" m ON m.id = r."modelId" AND m.status != 'Deleted'
LEFT JOIN (
  SELECT "reviewId", COUNT(*) count
  FROM "ImagesOnReviews"
  GROUP BY "reviewId"
) ior ON ior."reviewId" = r.id
WHERE ior.count > 0;

-- Attach images on reviews to associated posts
WITH matching_rows AS (
  SELECT
    i.id AS image_id,
    p.id AS post_id
  FROM "ImagesOnReviews" ior
  JOIN "Image" i ON ior."imageId" = i.id
  JOIN "Post" p ON p.title = CONCAT('r-', ior."reviewId"::text)
)
UPDATE "Image" img
SET "postId" = matching_rows.post_id
FROM matching_rows
WHERE img.id = matching_rows.image_id;

-- Remove temp post names
UPDATE "Post" p SET title = null
FROM "Review" r
WHERE CONCAT('r-', r.id) = p.title;
COMMIT;

-- Set indexes on images
WITH targeted AS (
	SELECT
	  ior."imageId",
	  ior.index
	FROM "ImagesOnReviews" ior
)
UPDATE "Image" i SET index = t.index
FROM targeted t
WHERE t."imageId" = i.id;

WITH targeted AS (
	SELECT
	  iom."imageId",
	  iom.index
	FROM "ImagesOnModels" iom
)
UPDATE "Image" i SET index = iom.index
FROM targeted iom
WHERE iom."imageId" = i.id;

-- Attach tags to posts based on image tags for posts without tags...
WITH tags_on_post AS (
	SELECT DISTINCT
	  i."postId" post_id,
	  t.id tag_id
	FROM "TagsOnImage" toi
	JOIN "Image" i ON i.id = toi."imageId"
	JOIN "Tag" t ON t.id = toi."tagId"
	WHERE t."isCategory" AND i."postId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "TagsOnPost" top
    WHERE top."postId" = i."postId"
  )
), top_rows AS (
  SELECT
    *,
    ROW_NUMBER() OVER (PARTITION BY post_id ORDER BY tag_id DESC) AS row_num
  FROM tags_on_post
)
INSERT INTO "TagsOnPost"("postId","tagId","createdAt")
SELECT
  post_id,
  tag_id,
  now()
FROM top_rows
WHERE row_num <= 5
ON CONFLICT ("postId", "tagId") DO NOTHING;