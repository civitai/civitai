 SELECT "EntityMetric"."entityId" AS "imageId",
    sum(
        CASE
            WHEN ("EntityMetric"."metricType" = 'ReactionLike'::"EntityMetric_MetricType_Type") THEN "EntityMetric"."metricValue"
            ELSE NULL::integer
        END) AS "reactionLike",
    sum(
        CASE
            WHEN ("EntityMetric"."metricType" = 'ReactionHeart'::"EntityMetric_MetricType_Type") THEN "EntityMetric"."metricValue"
            ELSE NULL::integer
        END) AS "reactionHeart",
    sum(
        CASE
            WHEN ("EntityMetric"."metricType" = 'ReactionLaugh'::"EntityMetric_MetricType_Type") THEN "EntityMetric"."metricValue"
            ELSE NULL::integer
        END) AS "reactionLaugh",
    sum(
        CASE
            WHEN ("EntityMetric"."metricType" = 'ReactionCry'::"EntityMetric_MetricType_Type") THEN "EntityMetric"."metricValue"
            ELSE NULL::integer
        END) AS "reactionCry",
    sum(
        CASE
            WHEN ("EntityMetric"."metricType" = ANY (ARRAY['ReactionLike'::"EntityMetric_MetricType_Type", 'ReactionHeart'::"EntityMetric_MetricType_Type", 'ReactionLaugh'::"EntityMetric_MetricType_Type", 'ReactionCry'::"EntityMetric_MetricType_Type"])) THEN "EntityMetric"."metricValue"
            ELSE NULL::integer
        END) AS "reactionTotal",
    sum(
        CASE
            WHEN ("EntityMetric"."metricType" = 'Comment'::"EntityMetric_MetricType_Type") THEN "EntityMetric"."metricValue"
            ELSE NULL::integer
        END) AS comment,
    sum(
        CASE
            WHEN ("EntityMetric"."metricType" = 'Collection'::"EntityMetric_MetricType_Type") THEN "EntityMetric"."metricValue"
            ELSE NULL::integer
        END) AS collection,
    sum(
        CASE
            WHEN ("EntityMetric"."metricType" = 'Buzz'::"EntityMetric_MetricType_Type") THEN "EntityMetric"."metricValue"
            ELSE NULL::integer
        END) AS buzz
   FROM "EntityMetric"
  WHERE ("EntityMetric"."entityType" = 'Image'::"EntityMetric_EntityType_Type")
  GROUP BY "EntityMetric"."entityId";