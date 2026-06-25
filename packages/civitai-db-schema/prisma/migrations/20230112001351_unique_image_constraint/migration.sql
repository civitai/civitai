/*
  Warnings:

  - A unique constraint covering the columns `[imageId]` on the table `ImagesOnModels` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[imageId]` on the table `ImagesOnReviews` will be added. If there are existing duplicate values, this will fail.

*/
-- De-dupe
WITH problems AS (
	SELECT "imageId", MIN("modelVersionId") "minVersionId", COUNT(1)
	FROM "ImagesOnModels"
	GROUP BY "imageId"
	HAVING COUNT(1) > 1
)
INSERT INTO "Image"(name, url, "createdAt", "updatedAt", hash, nsfw, "userId", height, width, meta, "tosViolation", "analysis")
SELECT i.name, url, "createdAt", "updatedAt", hash, nsfw, "userId", height, width, jsonb_build_object('modelVersionId', iom."modelVersionId"), "tosViolation", "analysis"
FROM "Image" i
JOIN problems p ON p."imageId" = i.id
JOIN "ImagesOnModels" iom ON iom."imageId" = i.id AND iom."modelVersionId" != p."minVersionId";

WITH problems AS (
    SELECT "imageId", MIN("modelVersionId") "minVersionId", COUNT(1)
    FROM "ImagesOnModels"
    GROUP BY "imageId"
    HAVING COUNT(1) > 1
)
UPDATE "ImagesOnModels" iom
SET "imageId" = i2.id
FROM problems p, "Image" i, "Image" i2
WHERE iom."imageId" = p."imageId" AND iom."modelVersionId" != p."minVersionId"
AND i.id = iom."imageId"
AND i2.name = i.name AND CAST(i2.meta->>'modelVersionId' AS INT) = iom."modelVersionId";

-- CreateIndex
CREATE UNIQUE INDEX "ImagesOnModels_imageId_key" ON "ImagesOnModels"("imageId");

-- CreateIndex
CREATE UNIQUE INDEX "ImagesOnReviews_imageId_key" ON "ImagesOnReviews"("imageId");
