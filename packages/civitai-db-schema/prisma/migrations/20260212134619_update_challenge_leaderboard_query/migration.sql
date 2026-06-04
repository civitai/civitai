-- Update the challenge leaderboard query to include the new Challenge/ChallengeWinner tables.
-- The old query only read from article-based challenges (Articles in collection 6236625).
-- The new Challenge Platform stores data in Challenge + ChallengeWinner tables instead.
-- This query reads from BOTH systems to maintain historical data during the transition.

UPDATE "Leaderboard"
SET query = $query$
WITH
-- OLD SYSTEM: Article-based challenges (collection 6236625)
old_challenges AS (
  SELECT
    (a.metadata->'collectionId')::int as "collectionId",
    (a.metadata->'winners') as "winners"
  FROM "CollectionItem" ci
  JOIN "Article" a ON a.id = ci."articleId"
  WHERE ci."collectionId" = 6236625
  AND ci."updatedAt" > now() - interval '30 days'
),
old_participants AS (
  SELECT
    ci."addedById" as "userId",
    oc."collectionId"
  FROM "CollectionItem" ci
  JOIN old_challenges oc ON oc."collectionId" = ci."collectionId"
  WHERE ci.status = 'ACCEPTED'
  GROUP BY 1, 2
  HAVING count(*) >= 10
),
old_participation_points AS (
  SELECT
    "userId",
    COUNT(*) as count,
    0 as first,
    0 as second,
    0 as third,
    COUNT(*) * 10 as points
  FROM old_participants
  GROUP BY 1
),
old_winner_positions AS (
  SELECT
    winner_id::int AS winner,
    position
  FROM old_challenges,
  LATERAL jsonb_array_elements_text(winners) WITH ORDINALITY AS arr(winner_id, position)
),
old_winner_points AS (
  SELECT
    winner as "userId",
    0 as count,
    SUM(IIF(position = 1, 1, 0)) as first,
    SUM(IIF(position = 2, 1, 0)) as second,
    SUM(IIF(position = 3, 1, 0)) as third,
    SUM((3 - position + 1) * 50) as points
  FROM old_winner_positions
  GROUP BY 1
),

-- NEW SYSTEM: Challenge table-based
new_challenges AS (
  SELECT
    c.id as "challengeId",
    c."collectionId",
    c."entryPrizeRequirement"
  FROM "Challenge" c
  WHERE c.status = 'Completed'
  AND c."startsAt" > now() - interval '30 days'
  AND c."collectionId" IS NOT NULL
),
new_participants AS (
  SELECT
    ci."addedById" as "userId",
    nc."challengeId"
  FROM "CollectionItem" ci
  JOIN new_challenges nc ON nc."collectionId" = ci."collectionId"
  WHERE ci.status = 'ACCEPTED'
  GROUP BY ci."addedById", nc."challengeId", nc."entryPrizeRequirement"
  HAVING count(*) >= nc."entryPrizeRequirement"
),
new_participation_points AS (
  SELECT
    "userId",
    COUNT(*) as count,
    0 as first,
    0 as second,
    0 as third,
    COUNT(*) * 10 as points
  FROM new_participants
  GROUP BY 1
),
new_winner_points AS (
  SELECT
    cw."userId",
    0 as count,
    SUM(CASE WHEN cw.place = 1 THEN 1 ELSE 0 END) as first,
    SUM(CASE WHEN cw.place = 2 THEN 1 ELSE 0 END) as second,
    SUM(CASE WHEN cw.place = 3 THEN 1 ELSE 0 END) as third,
    SUM(cw."pointsAwarded") as points
  FROM "ChallengeWinner" cw
  JOIN new_challenges nc ON nc."challengeId" = cw."challengeId"
  GROUP BY 1
),

-- COMBINE all sources
all_points AS (
  SELECT * FROM old_participation_points
  UNION ALL
  SELECT * FROM old_winner_points
  UNION ALL
  SELECT * FROM new_participation_points
  UNION ALL
  SELECT * FROM new_winner_points
),
scores AS (
  SELECT
    "userId",
    SUM(points) as score,
    jsonb_build_object(
      'entries', SUM("count"),
      'gold', SUM(first),
      'silver', SUM(second),
      'bronze', SUM(third)
    ) metrics
  FROM all_points
  GROUP BY 1
)
$query$
WHERE id = 'challenge';
