create or replace view "ImageResourceHelper"
    (id, "imageId", "reviewId", "reviewRating", "reviewRecommended", "reviewDetails", "reviewCreatedAt", name, hash, "modelVersionId",
     "modelVersionName", "modelVersionCreatedAt", "modelId", "modelName", "modelThumbsUpCount", "modelThumbsDownCount", "modelDownloadCount",
     "modelCommentCount", "modelType", "postId", "modelRating", "modelRatingCount", "modelFavoriteCount", "modelVersionBaseModel", detected)
as
SELECT ir.id,
       ir."imageId",
       rr.id                 AS "reviewId",
       rr.rating             AS "reviewRating",
       rr.recommended        AS "reviewRecommended",
       rr.details            AS "reviewDetails",
       rr."createdAt"        AS "reviewCreatedAt",
       ir.name,
       ir.hash,
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
FROM "ImageResource" ir
       JOIN "Image" i ON i.id = ir."imageId"
       LEFT JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
       LEFT JOIN "Model" m ON m.id = mv."modelId"
       LEFT JOIN "ModelVersionMetric" mvm ON mvm."modelVersionId" = ir."modelVersionId" AND mvm.timeframe = 'AllTime'::"MetricTimeframe"
       LEFT JOIN "ResourceReview" rr ON rr."modelVersionId" = mv.id AND rr."userId" = i."userId"
;
