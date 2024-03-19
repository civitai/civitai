-- Add new enum values
ALTER TYPE "ModelEngagementType" ADD VALUE 'Mute';
ALTER TYPE "ModelEngagementType" ADD VALUE 'Notify';

-- Add new metrics
ALTER TABLE "ModelMetric"
  ADD COLUMN     "thumbsDownCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN     "thumbsUpCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "updatedAt" TIMESTAMP(3);
ALTER TABLE "ModelVersionMetric"
  ADD COLUMN     "thumbsDownCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN     "thumbsUpCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "updatedAt" TIMESTAMP(3);

-- Update Resource Reviews
ALTER TABLE "ResourceReview" ADD COLUMN     "recommended" BOOLEAN NOT NULL DEFAULT true;
-- UPDATE "ResourceReview" SET "recommended" = false WHERE rating < 3;

-- Update metrics
/*
INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "thumbsUpCount", "thumbsDownCount")
SELECT
  mv.id,
  tf.timeframe,
  COALESCE(SUM(
    CASE
        WHEN rr."userId" IS NULL OR rr.recommended = false THEN 0
        WHEN tf.timeframe = 'AllTime' THEN 1
        WHEN tf.timeframe = 'Year' THEN IIF(rr.created_at >= NOW() - interval '1 year', 1, 0)
        WHEN tf.timeframe = 'Month' THEN IIF(rr.created_at >= NOW() - interval '1 month', 1, 0)
        WHEN tf.timeframe = 'Week' THEN IIF(rr.created_at >= NOW() - interval '1 week', 1, 0)
        WHEN tf.timeframe = 'Day' THEN IIF(rr.created_at >= NOW() - interval '1 day', 1, 0)
    END
  ), 0),
  COALESCE(SUM(
    CASE
        WHEN rr."userId" IS NULL OR rr.recommended = true THEN 0
        WHEN tf.timeframe = 'AllTime' THEN 1
        WHEN tf.timeframe = 'Year' THEN IIF(rr.created_at >= NOW() - interval '1 year', 1, NULL)
        WHEN tf.timeframe = 'Month' THEN IIF(rr.created_at >= NOW() - interval '1 month', 1, NULL)
        WHEN tf.timeframe = 'Week' THEN IIF(rr.created_at >= NOW() - interval '1 week', 1, NULL)
        WHEN tf.timeframe = 'Day' THEN IIF(rr.created_at >= NOW() - interval '1 day', 1, NULL)
    END
  ), 0)
FROM (
    SELECT
        r."userId",
        r."modelVersionId",
        BOOL_OR(r.recommended) AS recommended,
        MAX(r."createdAt") AS created_at
    FROM "ResourceReview" r
    JOIN "Model" m ON m.id = r."modelId" AND m."userId" != r."userId"
    WHERE r.exclude = FALSE
    AND r."tosViolation" = FALSE
    GROUP BY r."userId", r."modelVersionId"
) rr
JOIN "ModelVersion" mv ON rr."modelVersionId" = mv."id" -- confirm that model version exists
CROSS JOIN ( SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe ) tf
GROUP BY mv.id, tf.timeframe
ON CONFLICT ("modelVersionId", timeframe) DO UPDATE SET "thumbsUpCount" = EXCLUDED."thumbsUpCount", "thumbsDownCount" = EXCLUDED."thumbsDownCount", "updatedAt" = now();
*/

-- Add missing model metrics
ALTER TABLE "ModelMetric" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP DEFAULT now();
INSERT INTO "ModelMetric" ("modelId", timeframe, "updatedAt")
SELECT
  id,
  timeframe,
  "createdAt"
FROM "Model"
CROSS JOIN (
  SELECT UNNEST(ENUM_RANGE(NULL::"MetricTimeframe")) AS timeframe
) tf(timeframe)
ON CONFLICT DO NOTHING;

-- Update Image Helper
drop view "PostResourceHelper";
drop view "ImageResourceHelper";
create view "ImageResourceHelper" as
SELECT
	ir.id,
	ir."imageId",
	rr.id                     AS "reviewId",
	rr.rating                 AS "reviewRating",
  rr.recommended            AS "reviewRecommended",
	rr.details                AS "reviewDetails",
	rr."createdAt"            AS "reviewCreatedAt",
	ir.name,
	ir.hash,
	mv.id                     AS "modelVersionId",
	mv.name                   AS "modelVersionName",
	mv."createdAt"            AS "modelVersionCreatedAt",
	m.id                      AS "modelId",
	m.name                    AS "modelName",
	mvm."thumbsUpCount"       AS "modelThumbsUpCount",
	mvm."thumbsDownCount"     AS "modelThumbsDownCount",
	mvm."downloadCount"       AS "modelDownloadCount",
	mvm."commentCount"        AS "modelCommentCount",
	m.type                    AS "modelType",
	i."postId",
-- Leave deprecated fields for now
  mvm."rating"              AS "modelRating",
  mvm."ratingCount"         AS "modelRatingCount",
  mvm."favoriteCount"       AS "modelFavoriteCount"
FROM "ImageResource" ir
JOIN "Image" i ON i.id = ir."imageId"
LEFT JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
LEFT JOIN "Model" m ON m.id = mv."modelId"
LEFT JOIN "ModelVersionMetric" mvm ON mvm."modelVersionId" = ir."modelVersionId" AND timeframe = 'AllTime'
LEFT JOIN "ResourceReview" rr ON rr."modelVersionId" = mv.id AND rr."userId" = i."userId";

create view "PostResourceHelper" as
SELECT DISTINCT ON ("ImageResourceHelper"."postId", "ImageResourceHelper".name, "ImageResourceHelper"."modelVersionId")
	"ImageResourceHelper".id,
	"ImageResourceHelper"."imageId",
	"ImageResourceHelper"."reviewId",
	"ImageResourceHelper"."reviewRating",
	"ImageResourceHelper"."reviewRecommended",
	"ImageResourceHelper"."reviewDetails",
	"ImageResourceHelper"."reviewCreatedAt",
	"ImageResourceHelper".name,
	"ImageResourceHelper"."modelVersionId",
	"ImageResourceHelper"."modelVersionName",
	"ImageResourceHelper"."modelVersionCreatedAt",
	"ImageResourceHelper"."modelId",
	"ImageResourceHelper"."modelName",
	"ImageResourceHelper"."modelThumbsUpCount",
	"ImageResourceHelper"."modelThumbsDownCount",
	"ImageResourceHelper"."modelDownloadCount",
	"ImageResourceHelper"."modelCommentCount",
	"ImageResourceHelper"."modelType",
	"ImageResourceHelper"."postId",
-- Leave deprecated fields for now
  "ImageResourceHelper"."modelRating",
  "ImageResourceHelper"."modelRatingCount",
  "ImageResourceHelper"."modelFavoriteCount"
FROM "ImageResourceHelper";

-- Copy over collections from model engagements
-- Copy favorites to notify
-- https://civitai.com/api/admin/migrate-likes
