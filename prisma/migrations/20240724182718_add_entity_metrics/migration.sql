CREATE TYPE "EntityMetric_EntityType_Type" AS ENUM ('Image');

CREATE TYPE "EntityMetric_MetricType_Type" AS ENUM ('ReactionLike', 'ReactionHeart', 'ReactionLaugh', 'ReactionCry', 'Comment', 'Collection', 'Buzz');

CREATE TABLE "EntityMetric" (
    "entityType" "EntityMetric_EntityType_Type" NOT NULL,
    "entityId" INTEGER NOT NULL,
    "metricType" "EntityMetric_MetricType_Type" NOT NULL,
    "metricValue" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "EntityMetric_pkey" PRIMARY KEY ("entityType","entityId","metricType")
);

CREATE OR REPLACE VIEW "EntityMetricImage" AS
  SELECT
    "entityId" as "imageId",
    SUM(CASE WHEN "metricType" = 'ReactionLike' THEN "metricValue" ELSE 0 END) as "reactionLike",
    SUM(CASE WHEN "metricType" = 'ReactionHeart' THEN "metricValue" ELSE 0 END) as "reactionHeart",
    SUM(CASE WHEN "metricType" = 'ReactionLaugh' THEN "metricValue" ELSE 0 END) as "reactionLaugh",
    SUM(CASE WHEN "metricType" = 'ReactionCry' THEN "metricValue" ELSE 0 END) as "reactionCry",
    SUM(CASE WHEN "metricType" in ('ReactionLike', 'ReactionHeart', 'ReactionLaugh', 'ReactionCry') THEN "metricValue" ELSE 0 END) as "reactionTotal",
    SUM(CASE WHEN "metricType" = 'Comment' THEN "metricValue" ELSE 0 END) as "comment",
    SUM(CASE WHEN "metricType" = 'Collection' THEN "metricValue" ELSE 0 END) as "collection",
    SUM(CASE WHEN "metricType" = 'Buzz' THEN "metricValue" ELSE 0 END) as "buzz"
  FROM "EntityMetric"
  WHERE "entityType" = 'Image'
  GROUP BY "imageId"
;
