-- AlterTable
ALTER TABLE "TagMetric" ADD COLUMN     "articleCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "TagRank" ADD COLUMN     "articleCountAllTimeRank" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "articleCountDayRank" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "articleCountMonthRank" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "articleCountWeekRank" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "articleCountYearRank" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ArticleMetric" (
    "articleId" INTEGER NOT NULL,
    "timeframe" "MetricTimeframe" NOT NULL,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "dislikeCount" INTEGER NOT NULL DEFAULT 0,
    "laughCount" INTEGER NOT NULL DEFAULT 0,
    "cryCount" INTEGER NOT NULL DEFAULT 0,
    "heartCount" INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "viewCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ArticleMetric_pkey" PRIMARY KEY ("articleId","timeframe")
);

-- Create ArticleRank_Live view
CREATE VIEW "ArticleRank_Live" AS
WITH timeframe_stats AS (
  SELECT
		m."articleId",
        COALESCE(m."heartCount", 0) AS "heartCount",
        COALESCE(m."likeCount", 0) AS "likeCount",
        COALESCE(m."dislikeCount", 0) AS "dislikeCount",
        COALESCE(m."laughCount", 0) AS "laughCount",
        COALESCE(m."cryCount", 0) AS "cryCount",
        COALESCE(m."commentCount", 0) AS "commentCount",
        COALESCE(m."heartCount" + m."likeCount" + m."dislikeCount" + m."laughCount" + m."cryCount", 0) AS "reactionCount",
        COALESCE(m."viewCount", 0) AS "viewCount",
		m.timeframe
	FROM "ArticleMetric" m
), timeframe_rank AS (
  SELECT
    "articleId",
    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("commentCount", 0) DESC, COALESCE("reactionCount", 0) DESC, "articleId" DESC) AS "heartCountRank",
    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("likeCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("commentCount", 0) DESC, COALESCE("reactionCount", 0) DESC, "articleId" DESC) AS "likeCountRank",
    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("dislikeCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("commentCount", 0) DESC, "articleId" DESC) AS "dislikeCountRank",
    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("laughCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("commentCount", 0) DESC, "articleId" DESC) AS "laughCountRank",
    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("cryCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("commentCount", 0) DESC, "articleId" DESC) AS "cryCountRank",
    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("reactionCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("commentCount", 0) DESC, "articleId" DESC) AS "reactionCountRank",
    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("commentCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("laughCount", 0) DESC, "articleId" DESC) AS "commentCountRank",
     ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("viewCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("laughCount", 0) DESC, "articleId" DESC) AS "viewCountRank",
    timeframe
  FROM timeframe_stats
)
SELECT
	"articleId",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "heartCountRank", NULL::bigint))::int AS "heartCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "heartCountRank", NULL::bigint))::int AS "heartCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "heartCountRank", NULL::bigint))::int AS "heartCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "heartCountRank", NULL::bigint))::int AS "heartCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "heartCountRank", NULL::bigint))::int AS "heartCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "likeCountRank", NULL::bigint))::int AS "likeCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "likeCountRank", NULL::bigint))::int AS "likeCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "likeCountRank", NULL::bigint))::int AS "likeCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "likeCountRank", NULL::bigint))::int AS "likeCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "likeCountRank", NULL::bigint))::int AS "likeCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "dislikeCountRank", NULL::bigint))::int AS "dislikeCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "dislikeCountRank", NULL::bigint))::int AS "dislikeCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "dislikeCountRank", NULL::bigint))::int AS "dislikeCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "dislikeCountRank", NULL::bigint))::int AS "dislikeCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "dislikeCountRank", NULL::bigint))::int AS "dislikeCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "laughCountRank", NULL::bigint))::int AS "laughCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "laughCountRank", NULL::bigint))::int AS "laughCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "laughCountRank", NULL::bigint))::int AS "laughCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "laughCountRank", NULL::bigint))::int AS "laughCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "laughCountRank", NULL::bigint))::int AS "laughCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "cryCountRank", NULL::bigint))::int AS "cryCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "cryCountRank", NULL::bigint))::int AS "cryCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "cryCountRank", NULL::bigint))::int AS "cryCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "cryCountRank", NULL::bigint))::int AS "cryCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "cryCountRank", NULL::bigint))::int AS "cryCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "reactionCountRank", NULL::bigint))::int AS "reactionCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "reactionCountRank", NULL::bigint))::int AS "reactionCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "reactionCountRank", NULL::bigint))::int AS "reactionCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "reactionCountRank", NULL::bigint))::int AS "reactionCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "reactionCountRank", NULL::bigint))::int AS "reactionCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "commentCountRank", NULL::bigint))::int AS "commentCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "commentCountRank", NULL::bigint))::int AS "commentCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "commentCountRank", NULL::bigint))::int AS "commentCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "commentCountRank", NULL::bigint))::int AS "commentCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "commentCountRank", NULL::bigint))::int AS "commentCountAllTimeRank",
    MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "viewCountRank", NULL::bigint))::int AS "viewCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "viewCountRank", NULL::bigint))::int AS "viewCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "viewCountRank", NULL::bigint))::int AS "viewCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "viewCountRank", NULL::bigint))::int AS "viewCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "viewCountRank", NULL::bigint))::int AS "viewCountAllTimeRank"
FROM timeframe_rank
GROUP BY "articleId";

-- Populate ArticleRank Table
CREATE TABLE "ArticleRank"
  AS SELECT * FROM "ArticleRank_Live";

-- Update TagRank_Live view
DROP VIEW IF EXISTS "TagRank_Live";

DROP VIEW IF EXISTS "TagStat";
CREATE VIEW "TagStat" AS
SELECT
"tagId",
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
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "imageCount", NULL)) AS "imageCountAllTime",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "postCount", NULL)) AS "postCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "postCount", NULL)) AS "postCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "postCount", NULL)) AS "postCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "postCount", NULL)) AS "postCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "postCount", NULL)) AS "postCountAllTime",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "articleCount", NULL)) AS "articleCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "articleCount", NULL)) AS "articleCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "articleCount", NULL)) AS "articleCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "articleCount", NULL)) AS "articleCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "articleCount", NULL)) AS "articleCountAllTime"
from "TagMetric"
GROUP BY "tagId";


CREATE VIEW "TagRank_Live" AS
SELECT
  "tagId",
	ROW_NUMBER() OVER (ORDER BY "followerCountDay" DESC, "modelCountDay" DESC, "hiddenCountDay" ASC, "tagId")::int AS "followerCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountWeek" DESC, "modelCountWeek" DESC, "hiddenCountWeek" ASC, "tagId")::int AS "followerCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountMonth" DESC, "modelCountMonth" DESC, "hiddenCountMonth" ASC, "tagId")::int AS "followerCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountYear" DESC, "modelCountYear" DESC, "hiddenCountYear" ASC, "tagId")::int AS "followerCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountAllTime" DESC, "modelCountAllTime" DESC, "hiddenCountAllTime" ASC, "tagId")::int AS "followerCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "hiddenCountDay" DESC, "modelCountDay" DESC, "followerCountDay" ASC, "tagId")::int AS "hiddenCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "hiddenCountWeek" DESC, "modelCountWeek" DESC, "followerCountWeek" ASC, "tagId")::int AS "hiddenCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "hiddenCountMonth" DESC, "modelCountMonth" DESC, "followerCountMonth" ASC, "tagId")::int AS "hiddenCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "hiddenCountYear" DESC, "modelCountYear" DESC, "followerCountYear" ASC, "tagId")::int AS "hiddenCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "hiddenCountAllTime" DESC, "modelCountAllTime" DESC, "followerCountAllTime" ASC, "tagId")::int AS "hiddenCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "modelCountDay" DESC, "followerCountDay" DESC, "hiddenCountDay" ASC, "tagId")::int AS "modelCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "modelCountWeek" DESC, "followerCountWeek" DESC, "hiddenCountWeek" ASC, "tagId")::int AS "modelCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "modelCountMonth" DESC, "followerCountMonth" DESC, "hiddenCountMonth" ASC, "tagId")::int AS "modelCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "modelCountYear" DESC, "followerCountYear" DESC, "hiddenCountYear" ASC, "tagId")::int AS "modelCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "modelCountAllTime" DESC, "followerCountAllTime" DESC, "hiddenCountAllTime" ASC, "tagId")::int AS "modelCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "imageCountDay" DESC, "followerCountDay" DESC, "hiddenCountDay" ASC, "tagId")::int AS "imageCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "imageCountWeek" DESC, "followerCountWeek" DESC, "hiddenCountWeek" ASC, "tagId")::int AS "imageCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "imageCountMonth" DESC, "followerCountMonth" DESC, "hiddenCountMonth" ASC, "tagId")::int AS "imageCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "imageCountYear" DESC, "followerCountYear" DESC, "hiddenCountYear" ASC, "tagId")::int AS "imageCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "imageCountAllTime" DESC, "followerCountAllTime" DESC, "hiddenCountAllTime" ASC, "tagId")::int AS "imageCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "postCountDay" DESC,  "imageCountDay" DESC, "hiddenCountDay" ASC, "tagId")::int AS "postCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "postCountWeek" DESC, "imageCountWeek" DESC, "hiddenCountWeek" ASC, "tagId")::int AS "postCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "postCountMonth" DESC, "imageCountMonth" DESC, "hiddenCountMonth" ASC, "tagId")::int AS "postCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "postCountYear" DESC, "imageCountYear" DESC, "hiddenCountYear" ASC, "tagId")::int AS "postCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "postCountAllTime" DESC, "imageCountAllTime" DESC, "hiddenCountAllTime" ASC, "tagId")::int AS "postCountAllTimeRank",
    ROW_NUMBER() OVER (ORDER BY "articleCountDay" DESC,  "imageCountDay" DESC, "hiddenCountDay" ASC, "tagId")::int AS "articleCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "articleCountWeek" DESC, "imageCountWeek" DESC, "hiddenCountWeek" ASC, "tagId")::int AS "articleCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "articleCountMonth" DESC, "imageCountMonth" DESC, "hiddenCountMonth" ASC, "tagId")::int AS "articleCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "articleCountYear" DESC, "imageCountYear" DESC, "hiddenCountYear" ASC, "tagId")::int AS "articleCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "articleCountAllTime" DESC, "imageCountAllTime" DESC, "hiddenCountAllTime" ASC, "tagId")::int AS "articleCountAllTimeRank"
FROM "TagStat";

DROP TABLE IF EXISTS "TagRank";
CREATE TABLE "TagRank"
  AS SELECT * FROM "TagRank_Live";

-- AddForeignKey
ALTER TABLE "ArticleMetric" ADD CONSTRAINT "ArticleMetric_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;
