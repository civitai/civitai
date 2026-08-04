-- "New & Upcoming Creators" board definitions.
--
-- Replaces the 31-day newness rule on the two existing boards with a 90-day
-- FIRST-PUBLISH window, and adds the red-domain variants. Scoring changes:
--   * models: hard cap at each creator's 20 best releases (the rank falloff alone
--     let a back-catalog dump outsum a curated release), follower cap, and an
--     entry floor
--   * images: score on DISTINCT reactors instead of summed reaction value, which
--     caps a sockpuppet's contribution at 1 point per creator
--   * both: a creator-freshness multiplier keyed on days since first publish, so
--     the board keeps turning over
--
-- The images boards carry no follower cap: the score is computed entirely in
-- ClickHouse (which has no follower data) and the leaderboard engine has no
-- PG-allowlist hand-off. Measured cost of the omission is 2 users out of ~10,000
-- eligible image creators.

UPDATE "Leaderboard" SET
  query = 'WITH first_publish AS (
	SELECT
		m2."userId",
		MIN(mv2."publishedAt") AS "firstPublish"
	FROM "ModelVersion" mv2
	JOIN "Model" m2 ON m2.id = mv2."modelId"
	WHERE mv2.status = ''Published''
	GROUP BY 1
	HAVING MIN(mv2."publishedAt") > now() - INTERVAL ''90 days''
), entries AS (
	SELECT
		m."userId",
		( -- Points
			(mvm."downloadCount" / 10) +
			(mvm."thumbsUpCount" * 3) +
			(mvm."generationCount" / 100)
		) * ( -- Age
		  1 - (1 * (EXTRACT(DAY FROM (now() - mv."publishedAt"))/30)^2)
		) as score,
		fp."firstPublish",
		mvm."thumbsUpCount",
		mvm."generationCount",
		mvm."downloadCount",
		mv."publishedAt"
	FROM "ModelVersionMetric" mvm
	JOIN "ModelVersion" mv ON mv.id = mvm."modelVersionId"
	JOIN "Model" m ON mv."modelId" = m.id
	JOIN first_publish fp ON fp."userId" = m."userId"
	LEFT JOIN "UserMetric" um ON um."userId" = m."userId" AND um.timeframe = ''AllTime''
	WHERE
	  mv."publishedAt" > current_date - INTERVAL ''30 days''
	  AND mvm.timeframe = ''AllTime''
	  AND mv.status = ''Published''
	  AND m.status = ''Published''
	  AND COALESCE(um."followerCount", 0) < 1000
	  AND CASE
      WHEN mv.meta->>''imageNsfwLevel'' IS NOT NULL
        THEN (mv.meta->>''imageNsfwLevel'')::int < 4
      ELSE mv.meta->>''imageNsfw'' IN (''None'', ''Soft'')
    END
), entries_ranked AS (
	SELECT
		*,
		row_number() OVER (PARTITION BY "userId" ORDER BY score DESC) rank
	FROM entries
), entries_multiplied AS (
  SELECT
    *,
    GREATEST(0, 1 - (rank/120::double precision)^0.5) as quantity_multiplier
  FROM entries_ranked
  WHERE rank <= 20
), scores AS (
	SELECT
	  "userId",
	  sqrt(greatest(SUM(score * quantity_multiplier),1)) * 1000
	    * (1 - LEAST(1, GREATEST(0, EXTRACT(DAY FROM (now() - MIN("firstPublish")))/90::double precision))^2) score,
	  jsonb_build_object(
	    ''thumbsUpCount'', SUM("thumbsUpCount"),
	    ''generationCount'', SUM("generationCount"),
	    ''downloadCount'', SUM("downloadCount"),
	    ''entries'', COUNT(*)
		) metrics
	FROM entries_multiplied er
	JOIN "User" u ON u.id = er."userId"
	WHERE u."deletedAt" IS NULL AND u.id > 0
	GROUP BY "userId"
	HAVING SUM("downloadCount") >= 100 OR SUM("generationCount") >= 100
)',
  "scoringDescription" = '√((downloads/10) +
(likes * 3) +
(generations/100))
---
First model published in the last 90 days
Fewer than 1,000 followers
Best 20 releases counted
Newer creators weighted higher',
  description = 'Top new creators this month',
  domain = ARRAY['green', 'blue']::"DomainColor"[]
WHERE id = 'new_creators';

UPDATE "Leaderboard" SET
  query = 'WITH new_creators AS (
  SELECT
    userId,
    min(createdAt) AS firstPublish
  FROM images_created
  GROUP BY userId
  HAVING firstPublish > now() - INTERVAL 90 DAY
), clickhouse_new_creator_scores AS (
  SELECT
    ic.userId AS userId,
    uniq(r.userId) AS raters,
    uniq(ic.id) AS images,
    1 - pow(least(1, greatest(0, (toUnixTimestamp(now()) - toUnixTimestamp(min(nc.firstPublish))) / (90 * 86400))), 2) AS freshness,
    toInt32(round(sqrt(greatest(raters, 1)) * 1000 * freshness)) AS score,
    toJSONString(map(''raterCount'', toInt32(raters), ''imageCount'', toInt32(images))) AS metrics
  FROM (
    SELECT entityId, userId, createdAt, argMax(metricValue, version) AS metricValue
    FROM entityMetricEvents_month
    WHERE entityType = ''Image''
      AND createdAt > now() - INTERVAL 30 DAY
      AND metricType IN (''Like'',''Heart'',''Cry'',''Laugh'',''ReactionLike'',''ReactionHeart'',''ReactionCry'',''ReactionLaugh'')
    GROUP BY entityType, entityId, metricType, userId, createdAt
  ) r
  JOIN images_created ic ON ic.id = r.entityId
  JOIN new_creators nc ON nc.userId = ic.userId
  WHERE ic.createdAt > now() - INTERVAL 30 DAY
    AND ic.nsfwLevel IN (''PG'', ''PG13'')
    AND r.userId != ic.userId
    AND r.userId NOT IN (SELECT userId FROM metricExcludedUsers WHERE active = 1)
    AND r.metricValue > 0
  GROUP BY 1
  HAVING raters >= 25
)
SELECT userId, score, metrics FROM clickhouse_new_creator_scores ORDER BY score DESC LIMIT 1000
SETTINGS max_memory_usage = 8000000000',
  "scoringDescription" = '√(unique reactors)
---
First post within the last 90 days
Counts distinct reactors, not total reactions
At least 25 unique reactors
Newer creators weighted higher',
  description = 'New creators with the most popular images',
  domain = ARRAY['green', 'blue']::"DomainColor"[]
WHERE id = 'images-new';

INSERT INTO "Leaderboard" (id, index, title, description, "scoringDescription", query, active, public, domain)
VALUES (
  'new_creators-red',
  4,
  'New Creators',
  'Top new creators this month',
  '√((downloads/10) +
(likes * 3) +
(generations/100))
---
First model published in the last 90 days
Fewer than 1,000 followers
Best 20 releases counted
Newer creators weighted higher',
  'WITH first_publish AS (
	SELECT
		m2."userId",
		MIN(mv2."publishedAt") AS "firstPublish"
	FROM "ModelVersion" mv2
	JOIN "Model" m2 ON m2.id = mv2."modelId"
	WHERE mv2.status = ''Published''
	GROUP BY 1
	HAVING MIN(mv2."publishedAt") > now() - INTERVAL ''90 days''
), entries AS (
	SELECT
		m."userId",
		( -- Points
			(mvm."downloadCount" / 10) +
			(mvm."thumbsUpCount" * 3) +
			(mvm."generationCount" / 100)
		) * ( -- Age
		  1 - (1 * (EXTRACT(DAY FROM (now() - mv."publishedAt"))/30)^2)
		) as score,
		fp."firstPublish",
		mvm."thumbsUpCount",
		mvm."generationCount",
		mvm."downloadCount",
		mv."publishedAt"
	FROM "ModelVersionMetric" mvm
	JOIN "ModelVersion" mv ON mv.id = mvm."modelVersionId"
	JOIN "Model" m ON mv."modelId" = m.id
	JOIN first_publish fp ON fp."userId" = m."userId"
	LEFT JOIN "UserMetric" um ON um."userId" = m."userId" AND um.timeframe = ''AllTime''
	WHERE
	  mv."publishedAt" > current_date - INTERVAL ''30 days''
	  AND mvm.timeframe = ''AllTime''
	  AND mv.status = ''Published''
	  AND m.status = ''Published''
	  AND COALESCE(um."followerCount", 0) < 1000
), entries_ranked AS (
	SELECT
		*,
		row_number() OVER (PARTITION BY "userId" ORDER BY score DESC) rank
	FROM entries
), entries_multiplied AS (
  SELECT
    *,
    GREATEST(0, 1 - (rank/120::double precision)^0.5) as quantity_multiplier
  FROM entries_ranked
  WHERE rank <= 20
), scores AS (
	SELECT
	  "userId",
	  sqrt(greatest(SUM(score * quantity_multiplier),1)) * 1000
	    * (1 - LEAST(1, GREATEST(0, EXTRACT(DAY FROM (now() - MIN("firstPublish")))/90::double precision))^2) score,
	  jsonb_build_object(
	    ''thumbsUpCount'', SUM("thumbsUpCount"),
	    ''generationCount'', SUM("generationCount"),
	    ''downloadCount'', SUM("downloadCount"),
	    ''entries'', COUNT(*)
		) metrics
	FROM entries_multiplied er
	JOIN "User" u ON u.id = er."userId"
	WHERE u."deletedAt" IS NULL AND u.id > 0
	GROUP BY "userId"
	HAVING SUM("downloadCount") >= 100 OR SUM("generationCount") >= 100
)',
  true,
  true,
  ARRAY['red']::"DomainColor"[]
) ON CONFLICT (id) DO UPDATE SET
  query = EXCLUDED.query,
  "scoringDescription" = EXCLUDED."scoringDescription",
  domain = EXCLUDED.domain,
  active = EXCLUDED.active,
  public = EXCLUDED.public;

INSERT INTO "Leaderboard" (id, index, title, description, "scoringDescription", query, active, public, domain)
VALUES (
  'images-new-red',
  21,
  'New Master Generators',
  'New creators with the most popular images',
  '√(unique reactors)
---
First post within the last 90 days
Counts distinct reactors, not total reactions
At least 25 unique reactors
Newer creators weighted higher',
  'WITH new_creators AS (
  SELECT
    userId,
    min(createdAt) AS firstPublish
  FROM images_created
  GROUP BY userId
  HAVING firstPublish > now() - INTERVAL 90 DAY
), clickhouse_new_creator_scores AS (
  SELECT
    ic.userId AS userId,
    uniq(r.userId) AS raters,
    uniq(ic.id) AS images,
    1 - pow(least(1, greatest(0, (toUnixTimestamp(now()) - toUnixTimestamp(min(nc.firstPublish))) / (90 * 86400))), 2) AS freshness,
    toInt32(round(sqrt(greatest(raters, 1)) * 1000 * freshness)) AS score,
    toJSONString(map(''raterCount'', toInt32(raters), ''imageCount'', toInt32(images))) AS metrics
  FROM (
    SELECT entityId, userId, createdAt, argMax(metricValue, version) AS metricValue
    FROM entityMetricEvents_month
    WHERE entityType = ''Image''
      AND createdAt > now() - INTERVAL 30 DAY
      AND metricType IN (''Like'',''Heart'',''Cry'',''Laugh'',''ReactionLike'',''ReactionHeart'',''ReactionCry'',''ReactionLaugh'')
    GROUP BY entityType, entityId, metricType, userId, createdAt
  ) r
  JOIN images_created ic ON ic.id = r.entityId
  JOIN new_creators nc ON nc.userId = ic.userId
  WHERE ic.createdAt > now() - INTERVAL 30 DAY
    AND ic.nsfwLevel != ''Blocked''
    AND r.userId != ic.userId
    AND r.userId NOT IN (SELECT userId FROM metricExcludedUsers WHERE active = 1)
    AND r.metricValue > 0
  GROUP BY 1
  HAVING raters >= 25
)
SELECT userId, score, metrics FROM clickhouse_new_creator_scores ORDER BY score DESC LIMIT 1000
SETTINGS max_memory_usage = 8000000000',
  true,
  true,
  ARRAY['red']::"DomainColor"[]
) ON CONFLICT (id) DO UPDATE SET
  query = EXCLUDED.query,
  "scoringDescription" = EXCLUDED."scoringDescription",
  domain = EXCLUDED.domain,
  active = EXCLUDED.active,
  public = EXCLUDED.public;
