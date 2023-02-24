-- AlterTable
ALTER TABLE "Image" ADD COLUMN     "featuredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TagMetric" ADD COLUMN     "imageCount" INTEGER NOT NULL DEFAULT 0;

-- Alter Tag Stats
DROP VIEW  "TagRank";
DROP VIEW IF EXISTS "TagStat";
CREATE VIEW "TagStat" AS
WITH stats_timeframe AS (
	SELECT
	  t.id,
	  tf.timeframe,
	  coalesce(sum(tm."followerCount"), 0) AS "followerCount",
	  coalesce(sum(tm."hiddenCount"), 0) AS "hiddenCount",
	  coalesce(sum(tm."modelCount"), 0) AS "modelCount",
	  coalesce(sum(tm."imageCount"), 0) AS "imageCount"
	FROM "Tag" t
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "TagMetric" tm ON tm."tagId" = t.id AND tm.timeframe = tf.timeframe
	GROUP BY t.id, tf.timeframe
)
SELECT
id "tagId",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountAllTime",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "hiddenCount", NULL)) AS "hiddenCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "hiddenCount", NULL)) AS "hiddenCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "hiddenCount", NULL)) AS "hiddenCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "hiddenCount", NULL)) AS "hiddenCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "hiddenCount", NULL)) AS "hiddenCountAllTime",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "modelCount", NULL)) AS "modelCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "modelCount", NULL)) AS "modelCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "modelCount", NULL)) AS "modelCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "modelCount", NULL)) AS "modelCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "modelCount", NULL)) AS "modelCountAllTime",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "imageCount", NULL)) AS "imageCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "imageCount", NULL)) AS "imageCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "imageCount", NULL)) AS "imageCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "imageCount", NULL)) AS "imageCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "imageCount", NULL)) AS "imageCountAllTime"
from stats_timeframe
GROUP BY "id";

-- Alter Tag Rank
CREATE VIEW "TagRank" AS
SELECT
  "tagId",
	ROW_NUMBER() OVER (ORDER BY "followerCountDay" DESC, "modelCountDay" DESC, "hiddenCountDay" ASC, "tagId") AS "followerCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountWeek" DESC, "modelCountWeek" DESC, "hiddenCountWeek" ASC, "tagId") AS "followerCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountMonth" DESC, "modelCountMonth" DESC, "hiddenCountMonth" ASC, "tagId") AS "followerCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountYear" DESC, "modelCountYear" DESC, "hiddenCountYear" ASC, "tagId") AS "followerCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountAllTime" DESC, "modelCountAllTime" DESC, "hiddenCountAllTime" ASC, "tagId") AS "followerCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "hiddenCountDay" DESC, "modelCountDay" DESC, "followerCountDay" ASC, "tagId") AS "hiddenCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "hiddenCountWeek" DESC, "modelCountWeek" DESC, "followerCountWeek" ASC, "tagId") AS "hiddenCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "hiddenCountMonth" DESC, "modelCountMonth" DESC, "followerCountMonth" ASC, "tagId") AS "hiddenCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "hiddenCountYear" DESC, "modelCountYear" DESC, "followerCountYear" ASC, "tagId") AS "hiddenCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "hiddenCountAllTime" DESC, "modelCountAllTime" DESC, "followerCountAllTime" ASC, "tagId") AS "hiddenCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "modelCountDay" DESC, "followerCountDay" DESC, "hiddenCountDay" ASC, "tagId") AS "modelCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "modelCountWeek" DESC, "followerCountWeek" DESC, "hiddenCountWeek" ASC, "tagId") AS "modelCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "modelCountMonth" DESC, "followerCountMonth" DESC, "hiddenCountMonth" ASC, "tagId") AS "modelCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "modelCountYear" DESC, "followerCountYear" DESC, "hiddenCountYear" ASC, "tagId") AS "modelCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "modelCountAllTime" DESC, "followerCountAllTime" DESC, "hiddenCountAllTime" ASC, "tagId") AS "modelCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "imageCountDay" DESC, "followerCountDay" DESC, "hiddenCountDay" ASC, "tagId") AS "imageCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "imageCountWeek" DESC, "followerCountWeek" DESC, "hiddenCountWeek" ASC, "tagId") AS "imageCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "imageCountMonth" DESC, "followerCountMonth" DESC, "hiddenCountMonth" ASC, "tagId") AS "imageCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "imageCountYear" DESC, "followerCountYear" DESC, "hiddenCountYear" ASC, "tagId") AS "imageCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "imageCountAllTime" DESC, "followerCountAllTime" DESC, "hiddenCountAllTime" ASC, "tagId") AS "imageCountAllTimeRank"
FROM "TagStat";

-- Set Tag Categories
UPDATE "Tag" SET "isCategory" = true
WHERE name IN ('portraits', 'video game', 'celebrity', 'fantasy', 'illustration', 'landscapes', 'architecture', 'graphic design', 'hentai', 'anime', 'porn', 'cartoon', 'style', 'man', 'woman', 'character', 'subject', 'object', 'scifi', 'retro', '3d');

-- Add featured images function
CREATE OR REPLACE FUNCTION feature_images(tags_to_exclude text, num_images_per_category integer)
RETURNS void AS $$
DECLARE
    tag_list text[] := string_to_array(tags_to_exclude, ',');
BEGIN
    WITH image_score AS (
        SELECT
          i.id,
          t.name category,
          (
            stat."reactionCountAllTime" * 0.3 +
            stat."likeCountAllTime" * 1 +
            stat."heartCountAllTime" * 1.3 +
            stat."laughCountAllTime" * 0.5 +
            stat."cryCountAllTime" * 0.3 +
            stat."dislikeCountAllTime" * -1 +
            stat."commentCountAllTime" * 1.3
          ) score
        FROM "Image" i
        JOIN "TagsOnImage" toi ON toi."imageId" = i.id
        JOIN "Tag" t ON toi."tagId" = t.id AND t."isCategory" = true AND t.name NOT IN (SELECT UNNEST(tag_list))
        JOIN "ImageStat" stat ON stat."imageId" = i.id
        WHERE i.nsfw = false AND i."featuredAt" IS NULL
    ), to_feature AS (
        SELECT
          id
        FROM (
            SELECT
              id,
              row_number() OVER (PARTITION BY category ORDER BY score DESC) featured_rank
            FROM image_score
        ) ranked
        WHERE featured_rank <= num_images_per_category
    )
    UPDATE "Image" i SET "featuredAt" = now()
    FROM to_feature tf
    WHERE i.id = tf.id;
END;
$$ LANGUAGE plpgsql;