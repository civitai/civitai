-- AlterTable
ALTER TABLE "ArticleMetric" ADD COLUMN     "collectedCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ImageMetric" ADD COLUMN     "collectedCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PostMetric" ADD COLUMN     "collectedCount" INTEGER NOT NULL DEFAULT 0;

INSERT INTO "ArticleMetric" ("articleId", timeframe, "collectedCount")
SELECT
    a."id",
    tf.timeframe,
    COALESCE(SUM(
        CASE
            WHEN tf.timeframe = 'AllTime' THEN 1
            WHEN tf.timeframe = 'Year' THEN IIF(i."createdAt" >= NOW() - interval '1 year', 1, 0)
            WHEN tf.timeframe = 'Month' THEN IIF(i."createdAt" >= NOW() - interval '1 month', 1, 0)
            WHEN tf.timeframe = 'Week' THEN IIF(i."createdAt" >= NOW() - interval '1 week', 1, 0)
            WHEN tf.timeframe = 'Day' THEN IIF(i."createdAt" >= NOW() - interval '1 day', 1, 0)
        END
    ), 0)
FROM (
    SELECT
        "articleId",
        ci."createdAt"
    FROM "CollectionItem" ci
    WHERE "articleId" IS NOT NULL
) i
JOIN "Article" a ON a."id" = i."articleId"
CROSS JOIN (
  SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
) tf
GROUP BY a."id", tf.timeframe
ON CONFLICT ("articleId", timeframe) DO UPDATE SET "collectedCount" = EXCLUDED."collectedCount";

INSERT INTO "ImageMetric" ("imageId", timeframe, "collectedCount")
SELECT
    img."id",
    tf.timeframe,
    COALESCE(SUM(
        CASE
            WHEN tf.timeframe = 'AllTime' THEN 1
            WHEN tf.timeframe = 'Year' THEN IIF(i."createdAt" >= NOW() - interval '1 year', 1, 0)
            WHEN tf.timeframe = 'Month' THEN IIF(i."createdAt" >= NOW() - interval '1 month', 1, 0)
            WHEN tf.timeframe = 'Week' THEN IIF(i."createdAt" >= NOW() - interval '1 week', 1, 0)
            WHEN tf.timeframe = 'Day' THEN IIF(i."createdAt" >= NOW() - interval '1 day', 1, 0)
        END
    ), 0)
FROM (
    SELECT
        "imageId",
        ci."createdAt"
    FROM "CollectionItem" ci
    WHERE "imageId" IS NOT NULL
) i
JOIN "Image" img ON img."id" = i."imageId"
CROSS JOIN (
  SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
) tf
GROUP BY img."id", tf.timeframe
ON CONFLICT ("imageId", timeframe) DO UPDATE SET "collectedCount" = EXCLUDED."collectedCount";

INSERT INTO "PostMetric" ("postId", timeframe, "collectedCount")
SELECT
    p."id",
    tf.timeframe,
    COALESCE(SUM(
        CASE
            WHEN tf.timeframe = 'AllTime' THEN 1
            WHEN tf.timeframe = 'Year' THEN IIF(i."createdAt" >= NOW() - interval '1 year', 1, 0)
            WHEN tf.timeframe = 'Month' THEN IIF(i."createdAt" >= NOW() - interval '1 month', 1, 0)
            WHEN tf.timeframe = 'Week' THEN IIF(i."createdAt" >= NOW() - interval '1 week', 1, 0)
            WHEN tf.timeframe = 'Day' THEN IIF(i."createdAt" >= NOW() - interval '1 day', 1, 0)
        END
    ), 0)
FROM (
    SELECT
        "postId",
        ci."createdAt"
    FROM "CollectionItem" ci
    WHERE "postId" IS NOT NULL
) i
JOIN "Post" p ON p."id" = i."postId"
CROSS JOIN (
  SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
) tf
GROUP BY p."id", tf.timeframe
ON CONFLICT ("postId", timeframe) DO UPDATE SET "collectedCount" = EXCLUDED."collectedCount";
