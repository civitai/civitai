drop view if exists public."UserStat";
create OR REPLACE view public."UserStat"
            ("userId", "uploadCountAllTime", "reviewCountAllTime", "downloadCountAllTime",
             "generationCountAllTime", "followingCountAllTime", "followerCountAllTime",
             "hiddenCountAllTime", "answerCountAllTime", "answerAcceptCountAllTime",
             "thumbsUpCountAllTime", "thumbsDownCountAllTime", "reactionCountAllTime")
as
WITH user_model_metrics AS (
    SELECT mm."userId",
      sum(mm."downloadCount") AS "downloadCountAllTime",
      sum(mm."generationCount") AS "generationCountAllTime",
      sum(mm."thumbsUpCount") AS "thumbsUpCountAllTime"
    FROM "ModelMetric" mm
    WHERE mm.status = 'Published'
    AND mm.availability != 'Private'
    GROUP BY mm."userId"
), user_counts AS (
    SELECT um."userId",
      COALESCE(sum(um."followingCount"), 0::bigint) AS "followingCountAllTime",
      COALESCE(sum(um."followerCount"), 0::bigint) AS "followerCountAllTime",
      COALESCE(sum(um."hiddenCount"), 0::bigint) AS "hiddenCountAllTime",
      COALESCE(sum(um."uploadCount"), 0::bigint) AS "uploadCountAllTime",
      COALESCE(sum(um."reviewCount"), 0::bigint) AS "reviewCountAllTime",
      COALESCE(sum(um."answerCount"), 0::bigint) AS "answerCountAllTime",
      COALESCE(sum(um."answerAcceptCount"), 0::bigint) AS "answerAcceptCountAllTime",
      COALESCE(sum(um."reactionCount"), 0::bigint) AS "reactionCountAllTime"
    FROM "UserMetric" um
    WHERE um.timeframe = 'AllTime'::"MetricTimeframe"
    GROUP BY um."userId"
)
SELECT u."userId",
  u."uploadCountAllTime",
  u."reviewCountAllTime",
  COALESCE(m."downloadCountAllTime", 0::bigint) AS "downloadCountAllTime",
  COALESCE(m."generationCountAllTime", 0::bigint) AS "generationCountAllTime",
  u."followingCountAllTime",
  u."followerCountAllTime",
  u."hiddenCountAllTime",
  u."answerCountAllTime",
  u."answerAcceptCountAllTime",
  COALESCE(m."thumbsUpCountAllTime", 0::bigint) AS "thumbsUpCountAllTime",
  0::bigint AS "thumbsDownCountAllTime",
  u."reactionCountAllTime",
  0 as "ratingAllTime",
  0 as "ratingCountAllTime",
  0 as "favoriteCountAllTime",
  0 as "ratingMonth",
  0 as "ratingCountMonth",
  0 as "downloadCountMonth",
  0 as "favoriteCountMonth",
  0 as "thumbsUpCountMonth",
  0 as "uploadCountMonth",
  0 as "answerCountMonth"
FROM user_counts u
LEFT JOIN user_model_metrics m ON m."userId" = u."userId";
