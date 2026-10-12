-- Crucible leaderboards: judges, competitors, hosts. Data rows, not schema. Apply by hand.
-- Inserted inactive and non-public. updateLegendsBoardResults scores every populated board whatever its
-- public flag, so a board populated before review would hand out Legendary Nameplates. To go live, re-run
-- each query read-only, then set active = true and public = true together. Badges come in a later migration.
-- Do not go live between 23:00 and 00:05 UTC: prepare-leaderboard reads the active boards at 23:00, and a
-- board activated after that has no rows when update-user-leaderboard-rank checks at 00:01.
-- prepare-leaderboard picks the engine from the query text. The judges query must contain 'WITH ' and
-- 'clickhouse_' (runs on ClickHouse); the Postgres queries must not contain 'clickhouse_' or
-- 'image_scores AS', and must end in a `scores` CTE with no final SELECT (the job appends one).

INSERT INTO "Leaderboard" (id, index, title, description, "scoringDescription", query, active, public)
SELECT v.id, (SELECT max(index) FROM "Leaderboard") + v.ord, v.title, v.description, v.scoring, v.query, false, false
FROM (VALUES
  ('crucible-judges', 1, 'Crucible Judges',
   'Judges who keep coming back to judge crucibles',
   E'√(votes in a crucible, up to 50) × 10, summed over crucibles\n---\nLast 30 days. Judging more crucibles counts for more than more votes in one',
$q$WITH clickhouse_crucible_judges AS (
  SELECT userId, crucibleId, count() AS votes
  FROM crucible_votes
  WHERE userId > 0 AND createdAt > now() - INTERVAL 30 DAY
  GROUP BY userId, crucibleId
)
SELECT
  userId,
  toInt32(round(sum(10 * sqrt(least(votes, 50))))) AS score,
  toJSONString(map('votes', toInt32(sum(votes)), 'crucibles', toInt32(count()))) AS metrics
FROM clickhouse_crucible_judges
GROUP BY userId
ORDER BY score DESC
LIMIT 1000$q$),
  ('crucible-competitors', 2, 'Crucible Competitors',
   'Entrants who finish high in crowded crucibles',
   E'1 point per entrant your best entry finished above\n---\nCompleted crucibles in the last 30 days with at least 5 placed entrants',
$q$WITH crucibles AS (
  SELECT id FROM "Crucible"
  WHERE status = 'Completed' AND "endAt" > now() - interval '30 days'
), best AS (
  SELECT e."crucibleId", e."userId", min(e.position) AS position
  FROM "CrucibleEntry" e
  JOIN crucibles c ON c.id = e."crucibleId"
  WHERE e.position IS NOT NULL
  GROUP BY 1, 2
), ranked AS (
  SELECT
    "crucibleId",
    "userId",
    row_number() OVER (PARTITION BY "crucibleId" ORDER BY position) AS rank,
    count(*) OVER (PARTITION BY "crucibleId") AS field
  FROM best
), scores AS (
  SELECT
    "userId",
    SUM(field - rank) AS score,
    jsonb_build_object(
      'crucibles', count(*),
      'wins', count(*) FILTER (WHERE rank = 1)
    ) AS metrics
  FROM ranked
  WHERE field >= 5
  GROUP BY 1
)$q$),
  ('crucible-hosts', 3, 'Crucible Hosts',
   'Hosts whose crucibles draw the most entrants',
   E'√(entrants) × 10 per completed crucible\n---\nLast 30 days. An entrant counts only if their account was at least 30 days old when they entered',
$q$WITH crucibles AS (
  SELECT id, "userId" FROM "Crucible"
  WHERE status = 'Completed' AND "endAt" > now() - interval '30 days'
), entrants AS (
  SELECT c.id, c."userId" AS "hostId", count(DISTINCT e."userId") AS n
  FROM crucibles c
  JOIN "CrucibleEntry" e ON e."crucibleId" = c.id
  JOIN "User" u ON u.id = e."userId"
  WHERE u."createdAt" <= e."createdAt" - interval '30 days'
    AND u."deletedAt" IS NULL
    AND u."bannedAt" IS NULL
  GROUP BY 1, 2
), scores AS (
  SELECT
    "hostId" AS "userId",
    SUM(10 * sqrt(n)) AS score,
    jsonb_build_object('crucibles', count(*), 'entrants', SUM(n)) AS metrics
  FROM entrants
  GROUP BY 1
)$q$)
) AS v(id, ord, title, description, scoring, query)
WHERE NOT EXISTS (SELECT 1 FROM "Leaderboard" l WHERE l.id = v.id);

-- Verify: three rows, all inactive and non-public.
-- SELECT id, index, active, public FROM "Leaderboard" WHERE id LIKE 'crucible-%';
