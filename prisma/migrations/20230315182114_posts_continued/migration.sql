/*
  Warnings:

  - You are about to drop the `ReviewV2` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[reviewId]` on the table `Thread` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "ReviewV2" DROP CONSTRAINT "ReviewV2_modelVersionId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewV2" DROP CONSTRAINT "ReviewV2_threadId_fkey";

-- AlterTable
ALTER TABLE "TagMetric" ADD COLUMN     "postCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "reviewId" INTEGER;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "onboarded" BOOLEAN DEFAULT false;

-- DropTable
DROP TABLE "ReviewV2";

-- CreateTable
CREATE TABLE "ResourceReview" (
    "id" SERIAL NOT NULL,
    "modelVersionId" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "details" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,

    CONSTRAINT "ResourceReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostMetric" (
    "postId" INTEGER NOT NULL,
    "timeframe" "MetricTimeframe" NOT NULL,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "dislikeCount" INTEGER NOT NULL DEFAULT 0,
    "laughCount" INTEGER NOT NULL DEFAULT 0,
    "cryCount" INTEGER NOT NULL DEFAULT 0,
    "heartCount" INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PostMetric_pkey" PRIMARY KEY ("postId","timeframe")
);

-- CreateIndex
CREATE UNIQUE INDEX "Thread_reviewId_key" ON "Thread"("reviewId");

-- CreateIndex
CREATE INDEX "Thread_reviewId_idx" ON "Thread" USING HASH ("reviewId");

-- CreateIndex
CREATE INDEX "Thread_postId_idx" ON "Thread" USING HASH ("postId");

-- CreateIndex
CREATE INDEX "Thread_questionId_idx" ON "Thread" USING HASH ("questionId");

-- CreateIndex
CREATE INDEX "Thread_imageId_idx" ON "Thread" USING HASH ("imageId");

-- AddForeignKey
ALTER TABLE "ResourceReview" ADD CONSTRAINT "ResourceReview_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceReview" ADD CONSTRAINT "ResourceReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostMetric" ADD CONSTRAINT "PostMetric_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "ResourceReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add Post Stats
CREATE OR REPLACE VIEW "PostStat" AS
WITH timeframe_stats AS (
  SELECT
		p.id AS "postId",
		COALESCE(mm."heartCount", 0) AS "heartCount",
		COALESCE(mm."likeCount", 0) AS "likeCount",
    COALESCE(mm."dislikeCount", 0) AS "dislikeCount",
    COALESCE(mm."laughCount", 0) AS "laughCount",
    COALESCE(mm."cryCount", 0) AS "cryCount",
		COALESCE(mm."commentCount", 0) AS "commentCount",
		tf.timeframe
	FROM "Post" p
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "PostMetric" mm ON mm."postId" = p.id AND mm.timeframe = tf.timeframe
)
SELECT
	"postId",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountAllTime"
FROM timeframe_stats ts
GROUP BY "postId";

-- Add Post Rank
CREATE MATERIALIZED VIEW "PostRank" AS
WITH timeframe_stats AS (
  SELECT
		p.id AS "postId",
		COALESCE(im."heartCount", 0) AS "heartCount",
		COALESCE(im."likeCount", 0) AS "likeCount",
    COALESCE(im."dislikeCount", 0) AS "dislikeCount",
    COALESCE(im."laughCount", 0) AS "laughCount",
    COALESCE(im."cryCount", 0) AS "cryCount",
		COALESCE(im."commentCount", 0) AS "commentCount",
		COALESCE(im."heartCount" + im."likeCount" + im."dislikeCount" + im."laughCount" + im."cryCount", 0) AS "reactionCount",
		tf.timeframe
	FROM "Post" p
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "PostMetric" im ON im."postId" = p.id AND im.timeframe = tf.timeframe
), timeframe_rank AS (
  SELECT
    "postId",
    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("commentCount", 0) DESC, COALESCE("reactionCount", 0) DESC, "postId" DESC) AS "heartCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("likeCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("commentCount", 0) DESC, COALESCE("reactionCount", 0) DESC, "postId" DESC) AS "likeCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("dislikeCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("commentCount", 0) DESC, "postId" DESC) AS "dislikeCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("laughCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("commentCount", 0) DESC, "postId" DESC) AS "laughCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("cryCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("commentCount", 0) DESC, "postId" DESC) AS "cryCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("reactionCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("commentCount", 0) DESC, "postId" DESC) AS "reactionCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("commentCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("laughCount", 0) DESC, "postId" DESC) AS "commentCountRank",
    timeframe
  FROM timeframe_stats
)
SELECT
	"postId",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "heartCountRank", NULL::bigint)) AS "heartCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "heartCountRank", NULL::bigint)) AS "heartCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "heartCountRank", NULL::bigint)) AS "heartCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "heartCountRank", NULL::bigint)) AS "heartCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "heartCountRank", NULL::bigint)) AS "heartCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "likeCountRank", NULL::bigint)) AS "likeCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "likeCountRank", NULL::bigint)) AS "likeCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "likeCountRank", NULL::bigint)) AS "likeCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "likeCountRank", NULL::bigint)) AS "likeCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "likeCountRank", NULL::bigint)) AS "likeCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "dislikeCountRank", NULL::bigint)) AS "dislikeCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "dislikeCountRank", NULL::bigint)) AS "dislikeCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "dislikeCountRank", NULL::bigint)) AS "dislikeCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "dislikeCountRank", NULL::bigint)) AS "dislikeCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "dislikeCountRank", NULL::bigint)) AS "dislikeCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "laughCountRank", NULL::bigint)) AS "laughCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "laughCountRank", NULL::bigint)) AS "laughCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "laughCountRank", NULL::bigint)) AS "laughCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "laughCountRank", NULL::bigint)) AS "laughCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "laughCountRank", NULL::bigint)) AS "laughCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "cryCountRank", NULL::bigint)) AS "cryCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "cryCountRank", NULL::bigint)) AS "cryCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "cryCountRank", NULL::bigint)) AS "cryCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "cryCountRank", NULL::bigint)) AS "cryCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "cryCountRank", NULL::bigint)) AS "cryCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "reactionCountRank", NULL::bigint)) AS "reactionCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "reactionCountRank", NULL::bigint)) AS "reactionCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "reactionCountRank", NULL::bigint)) AS "reactionCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "reactionCountRank", NULL::bigint)) AS "reactionCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "reactionCountRank", NULL::bigint)) AS "reactionCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountAllTimeRank"
FROM timeframe_rank
GROUP BY "postId";

CREATE UNIQUE INDEX prank_post_id ON "PostRank" ("postId");

-- This is an empty migration.
DROP MATERIALIZED VIEW IF EXISTS "TagRank";
DROP VIEW IF EXISTS "TagStat";

CREATE VIEW "TagStat" AS
WITH stats_timeframe AS (
	SELECT
	  t.id,
	  tf.timeframe,
	  coalesce(sum(tm."followerCount"), 0) AS "followerCount",
	  coalesce(sum(tm."hiddenCount"), 0) AS "hiddenCount",
	  coalesce(sum(tm."modelCount"), 0) AS "modelCount",
	  coalesce(sum(tm."imageCount"), 0) AS "imageCount",
	  coalesce(sum(tm."postCount"), 0) AS "postCount"
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
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "imageCount", NULL)) AS "imageCountAllTime",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "postCount", NULL)) AS "postCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "postCount", NULL)) AS "postCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "postCount", NULL)) AS "postCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "postCount", NULL)) AS "postCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "postCount", NULL)) AS "postCountAllTime"
from stats_timeframe
GROUP BY "id";

-- Add TagRank

CREATE MATERIALIZED VIEW "TagRank" AS
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
	ROW_NUMBER() OVER (ORDER BY "imageCountAllTime" DESC, "followerCountAllTime" DESC, "hiddenCountAllTime" ASC, "tagId") AS "imageCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "postCountDay" DESC,  "imageCountDay" DESC, "hiddenCountDay" ASC, "tagId") AS "postCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "postCountWeek" DESC, "imageCountWeek" DESC, "hiddenCountWeek" ASC, "tagId") AS "postCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "postCountMonth" DESC, "imageCountMonth" DESC, "hiddenCountMonth" ASC, "tagId") AS "postCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "postCountYear" DESC, "imageCountYear" DESC, "hiddenCountYear" ASC, "tagId") AS "postCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "postCountAllTime" DESC, "imageCountAllTime" DESC, "hiddenCountAllTime" ASC, "tagId") AS "postCountAllTimeRank"
FROM "TagStat";

CREATE UNIQUE INDEX trank_tag_id ON "TagRank" ("tagId");
