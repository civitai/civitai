-- AlterTable
ALTER TABLE "ArticleMetric" ADD COLUMN     "collectedCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ImageMetric" ADD COLUMN     "collectedCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PostMetric" ADD COLUMN     "collectedCount" INTEGER NOT NULL DEFAULT 0;

INSERT INTO "ArticleMetric" ("articleId", timeframe, "collectedCount")
SELECT
    ci."articleId",
    tf.timeframe,
    COALESCE(SUM(
        CASE
            WHEN tf.timeframe = 'AllTime' THEN 1
            WHEN tf.timeframe = 'Year' THEN IIF(ci."createdAt" >= NOW() - interval '1 year', 1, 0)
            WHEN tf.timeframe = 'Month' THEN IIF(ci."createdAt" >= NOW() - interval '1 month', 1, 0)
            WHEN tf.timeframe = 'Week' THEN IIF(ci."createdAt" >= NOW() - interval '1 week', 1, 0)
            WHEN tf.timeframe = 'Day' THEN IIF(ci."createdAt" >= NOW() - interval '1 day', 1, 0)
        END
    ), 0)
FROM "CollectionItem" ci
CROSS JOIN (
  SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
) tf
WHERE ci."articleId" IS NOT NULL
GROUP BY ci."articleId", tf.timeframe
ON CONFLICT ("articleId", timeframe) DO UPDATE SET "collectedCount" = EXCLUDED."collectedCount";

INSERT INTO "ImageMetric" ("imageId", timeframe, "collectedCount")
SELECT
    ci."imageId",
    tf.timeframe,
    COALESCE(SUM(
        CASE
            WHEN tf.timeframe = 'AllTime' THEN 1
            WHEN tf.timeframe = 'Year' THEN IIF(ci."createdAt" >= NOW() - interval '1 year', 1, 0)
            WHEN tf.timeframe = 'Month' THEN IIF(ci."createdAt" >= NOW() - interval '1 month', 1, 0)
            WHEN tf.timeframe = 'Week' THEN IIF(ci."createdAt" >= NOW() - interval '1 week', 1, 0)
            WHEN tf.timeframe = 'Day' THEN IIF(ci."createdAt" >= NOW() - interval '1 day', 1, 0)
        END
    ), 0)
FROM "CollectionItem" ci
CROSS JOIN (
  SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
) tf
WHERE ci."imageId" IS NOT NULL
GROUP BY ci."imageId", tf.timeframe
ON CONFLICT ("imageId", timeframe) DO UPDATE SET "collectedCount" = EXCLUDED."collectedCount";

INSERT INTO "PostMetric" ("postId", timeframe, "collectedCount")
SELECT
    ci."postId",
    tf.timeframe,
    COALESCE(SUM(
        CASE
            WHEN tf.timeframe = 'AllTime' THEN 1
            WHEN tf.timeframe = 'Year' THEN IIF(ci."createdAt" >= NOW() - interval '1 year', 1, 0)
            WHEN tf.timeframe = 'Month' THEN IIF(ci."createdAt" >= NOW() - interval '1 month', 1, 0)
            WHEN tf.timeframe = 'Week' THEN IIF(ci."createdAt" >= NOW() - interval '1 week', 1, 0)
            WHEN tf.timeframe = 'Day' THEN IIF(ci."createdAt" >= NOW() - interval '1 day', 1, 0)
        END
    ), 0)
FROM "CollectionItem" ci
CROSS JOIN (
  SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
) tf
WHERE ci."postId" IS NOT NULL
GROUP BY ci."postId", tf.timeframe
ON CONFLICT ("postId", timeframe) DO UPDATE SET "collectedCount" = EXCLUDED."collectedCount";
