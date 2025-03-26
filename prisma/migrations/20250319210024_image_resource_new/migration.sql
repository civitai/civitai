

-- CreateTable
CREATE TABLE "ImageResourceNew" (
    "imageId" INTEGER NOT NULL,
    "modelVersionId" INTEGER NOT NULL,
    "strength" INTEGER,
    "detected" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ImageResourceNew_pkey" PRIMARY KEY ("imageId","modelVersionId")
);

-- CreateIndex
CREATE INDEX "ImageResourceNew_modelVersionId_idx" ON "ImageResourceNew"("modelVersionId");

-- CreateTable
CREATE TABLE "ResourceOverride" (
    "hash" TEXT NOT NULL,
    "modelVersionId" INTEGER NOT NULL,
    "type" "ModelHashType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceOverride_pkey" PRIMARY KEY ("hash")
);

INSERT INTO "ResourceOverride" ("hash", "modelVersionId", "type")
SELECT
    lower(mfh.hash),
    mf."modelVersionId",
    mfh.type
FROM "ModelFileHash" mfh
JOIN "ModelFile" mf ON mf.id = mfh."fileId" AND mf.type = 'Model'
JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
WHERE mv."modelId" = 618692 AND mfh.type = 'AutoV2';

DROP FUNCTION IF EXISTS insert_image_resource;

DROP VIEW "PostResourceHelper";
DROP VIEW "ImageResourceHelper";
create or replace view "ImageResourceHelper"
    ("imageId", "reviewId", "reviewRating", "reviewRecommended", "reviewDetails", "reviewCreatedAt", name, "modelVersionId",
     "modelVersionName", "modelVersionCreatedAt", "modelId", "modelName", "modelThumbsUpCount", "modelThumbsDownCount", "modelDownloadCount",
     "modelCommentCount", "modelType", "postId", "modelRating", "modelRatingCount", "modelFavoriteCount", "modelVersionBaseModel", detected)
as
SELECT ir."imageId",
       rr.id                 AS "reviewId",
       rr.rating             AS "reviewRating",
       rr.recommended        AS "reviewRecommended",
       rr.details            AS "reviewDetails",
       rr."createdAt"        AS "reviewCreatedAt",
       concat_ws(' - ', m.name, mv.name) AS "name",
       mv.id                 AS "modelVersionId",
       mv.name               AS "modelVersionName",
       mv."createdAt"        AS "modelVersionCreatedAt",
       m.id                  AS "modelId",
       m.name                AS "modelName",
       mvm."thumbsUpCount"   AS "modelThumbsUpCount",
       mvm."thumbsDownCount" AS "modelThumbsDownCount",
       mvm."downloadCount"   AS "modelDownloadCount",
       mvm."commentCount"    AS "modelCommentCount",
       m.type                AS "modelType",
       i."postId",
       mvm.rating            AS "modelRating",
       mvm."ratingCount"     AS "modelRatingCount",
       mvm."favoriteCount"   AS "modelFavoriteCount",
       mv."baseModel"        AS "modelVersionBaseModel",
       ir.detected
FROM "ImageResourceNew" ir
       JOIN "Image" i ON i.id = ir."imageId"
       JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
       LEFT JOIN "Model" m ON m.id = mv."modelId"
       LEFT JOIN "ModelVersionMetric" mvm ON mvm."modelVersionId" = ir."modelVersionId" AND mvm.timeframe = 'AllTime'::"MetricTimeframe"
       LEFT JOIN "ResourceReview" rr ON rr."modelVersionId" = mv.id AND rr."userId" = i."userId"
;

CREATE OR REPLACE VIEW "ResourceReviewHelper" AS
SELECT
rr.id "resourceReviewId",
COUNT(DISTINCT i.id) "imageCount"
FROM "ResourceReview" rr
JOIN "ImageResourceNew" ir ON ir."modelVersionId" = rr."modelVersionId"
JOIN "Image" i ON i.id = ir."imageId" AND i."userId" = rr."userId"
WHERE ir."modelVersionId" = rr."modelVersionId"
GROUP BY rr.id;