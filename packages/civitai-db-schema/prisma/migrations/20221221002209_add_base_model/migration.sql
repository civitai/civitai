-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "meta" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "ModelVersion" ADD COLUMN     "baseModel" TEXT,
ADD COLUMN     "meta" JSONB NOT NULL DEFAULT '{}';

UPDATE "ModelVersion" SET "baseModel" = 'SD 1.5';

WITH sd_2 AS (
	SELECT DISTINCT tom."modelId"
	FROM "TagsOnModels" tom
	JOIN "Tag" t ON t.id = tom."tagId"
	JOIN "Model" m ON m.id = tom."modelId"
	WHERE t.name in ('sd2')
)
UPDATE "ModelVersion" SET "baseModel" = 'SD 2.0'
FROM sd_2
WHERE sd_2."modelId" = "ModelVersion"."modelId";

WITH sd_21 AS (
	SELECT DISTINCT tom."modelId"
	FROM "TagsOnModels" tom
	JOIN "Tag" t ON t.id = tom."tagId"
	JOIN "Model" m ON m.id = tom."modelId"
	WHERE t.name in ('sd2.1')
)
UPDATE "ModelVersion" SET "baseModel" = 'SD 2.1'
FROM sd_21
WHERE sd_21."modelId" = "ModelVersion"."modelId";

WITH sd_2_768 AS (
	SELECT DISTINCT tom."modelId"
	FROM "TagsOnModels" tom
	JOIN "Tag" t ON t.id = tom."tagId"
	JOIN "Model" m ON m.id = tom."modelId"
	WHERE t.name in ('sd2 768')
)
UPDATE "ModelVersion" SET "baseModel" = 'SD 2.0 768'
FROM sd_2_768
WHERE sd_2_768."modelId" = "ModelVersion"."modelId";