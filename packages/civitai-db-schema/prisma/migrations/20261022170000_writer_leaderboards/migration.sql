-- Writer leaderboards: Active Writers, Storytellers, Guide Writers, Rising Writers. Data rows, not schema. Apply by hand.
-- Inserted inactive and non-public: updateLegendsBoardResults scores every populated board whatever its
-- public flag, so a board populated before review would hand out Legendary Nameplates. To go live, run each
-- query read-only, then set active = true and public = true together, not between 23:00 and 00:05 UTC
-- (prepare-leaderboard reads active boards at 23:00; update-user-leaderboard-rank checks at 00:01).
-- Activate only once the build that replaces {{metricExcludedUserIds}} is deployed: before it the token is a
-- syntax error, and one failing board stops the whole nightly run, Legends and the cache purge included.
-- Queries end in a `scores` CTE with no final SELECT (the job appends one) and may use {{metricExcludedUserIds}}.
--
-- ROLLBACK (deletes the four boards and what they produced: results, Legends rows, populated markers, and
-- ranks taken from them, which are rebuilt from the remaining public boards as leaderboardRankInsert in
-- user.service.ts does). Run it BEFORE reverting the job change, for the same reason as above. To keep the
-- history instead, set active = false, public = false; Legends still counts a hidden board's past results.
-- Afterwards purge the `leaderboard` cache tag, or wait for clear-leaderboard-cache at midnight.
--   BEGIN;
--   SET LOCAL lock_timeout = '3s';
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM "Cosmetic" WHERE "leaderboardId" IN ('writer-active', 'writer-story', 'writer-guide', 'writer-rising')) THEN
--       RAISE EXCEPTION 'writer board badges exist: roll back their migration first';
--     END IF;
--   END $$;
--   CREATE TEMP TABLE writer_rank_users ON COMMIT DROP AS
--     SELECT "userId" FROM "UserRank" WHERE "leaderboardId" IN ('writer-active', 'writer-story', 'writer-guide', 'writer-rising');
--   DELETE FROM "UserRank" WHERE "userId" IN (SELECT "userId" FROM writer_rank_users);
--   DELETE FROM "LegendsBoardResult" WHERE "leaderboardId" IN ('writer-active', 'writer-story', 'writer-guide', 'writer-rising');
--   DELETE FROM "KeyValue" WHERE key IN ('leaderboard:populated:writer-active', 'leaderboard:populated:writer-story',
--     'leaderboard:populated:writer-guide', 'leaderboard:populated:writer-rising');
--   DELETE FROM "Leaderboard" WHERE id IN ('writer-active', 'writer-story', 'writer-guide', 'writer-rising');
--   INSERT INTO "UserRank" ("userId", "leaderboardRank", "leaderboardId", "leaderboardTitle", "leaderboardCosmetic")
--   SELECT DISTINCT ON (lr."userId")
--     lr."userId", lr.position, lr."leaderboardId", l.title,
--     (SELECT data ->> 'url' FROM "Cosmetic" c
--      WHERE c."leaderboardId" = lr."leaderboardId" AND lr.position <= c."leaderboardPosition"
--      ORDER BY c."leaderboardPosition" LIMIT 1)
--   FROM "LeaderboardResult" lr
--   JOIN "Leaderboard" l ON l.id = lr."leaderboardId" AND l.public
--   JOIN "User" u ON u.id = lr."userId"
--   WHERE lr.date = current_date AND lr.position <= 100
--     AND lr."userId" IN (SELECT "userId" FROM writer_rank_users)
--   ORDER BY lr."userId", (lr."leaderboardId" IS NOT DISTINCT FROM u."leaderboardShowcase") DESC, lr.position;
--   COMMIT;

INSERT INTO "Leaderboard" (id, index, title, description, "scoringDescription", query, active, public)
SELECT v.id, (SELECT max(index) FROM "Leaderboard") + v.ord, v.title, v.description, v.scoring, v.query, false, false
FROM (VALUES
  ('writer-active', 1, 'Active Writers',
   'Writers publishing now, scored article by article',
   E'Per article: √(views) / 2 + √(reactions) × 7 + √(bookmarks) × 10 + √(comments) × 5\n---\nArticles from the last 365 days; each loses half its points every 90 days\nYour best 30 articles count\nRelease notes (only announcement, news or event categories) earn a quarter',
$q$WITH article_value AS (
  SELECT
    a."userId",
    GREATEST(am."viewCount", 0) AS views,
    GREATEST(am."likeCount" + am."heartCount" + am."laughCount" + am."cryCount", 0) AS reactions,
    GREATEST(am."collectedCount", 0) AS bookmarks,
    GREATEST(am."commentCount", 0) AS comments,
    POWER(0.5, EXTRACT(EPOCH FROM (now() - a."publishedAt")) / 86400.0 / 90) AS w,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM "TagsOnArticle" ta JOIN "Tag" t ON t.id = ta."tagId" AND t."isCategory"
        WHERE ta."articleId" = a.id
      ) AND NOT EXISTS (
        SELECT 1 FROM "TagsOnArticle" ta JOIN "Tag" t ON t.id = ta."tagId" AND t."isCategory"
        WHERE ta."articleId" = a.id AND t.name NOT IN ('announcement', 'news', 'event')
      ) THEN 0.25
      ELSE 1
    END AS k
  FROM "Article" a
  JOIN "ArticleMetric" am ON am."articleId" = a.id AND am.timeframe = 'AllTime'
  WHERE a.status = 'Published'
    AND a.availability = 'Public'
    AND NOT a.unlisted
    AND NOT a."tosViolation"
    AND a."publishedAt" > now() - interval '365 days'
), valued AS (
  SELECT *, w * k * (SQRT(views) / 2 + SQRT(reactions) * 7 + SQRT(bookmarks) * 10 + SQRT(comments) * 5) AS v
  FROM article_value
), ranked AS (
  SELECT *, row_number() OVER (PARTITION BY "userId" ORDER BY v DESC) AS rn
  FROM valued
), scores AS (
  SELECT
    "userId",
    100 * SUM(v) AS score,
    jsonb_build_object(
      'articles', count(*),
      'viewCount', SUM(views),
      'reactionCount', SUM(reactions),
      'bookmark', SUM(bookmarks)
    ) AS metrics
  FROM ranked
  WHERE rn <= 30
  GROUP BY "userId"
)$q$),
  ('writer-story', 2, 'Storytellers',
   'Serial fiction that readers come back for',
   E'Per chapter: √(readers) × 7 + √(comments) × 10 + √(bookmarks) × 5 + √(views) / 4\n+ √(loyal readers) × 15, then × (0.5 + 0.5 × weeks with a new chapter in the last 12 / 12)\n---\nStory articles from the last 365 days; each loses half its points every 90 days\nYour best 20 chapters count\nLoyal readers reacted to 3 or more of your chapters in the last 90 days; your own reactions do not count',
$q$WITH story AS (
  SELECT
    a.id,
    a."userId",
    a."publishedAt",
    POWER(0.5, EXTRACT(EPOCH FROM (now() - a."publishedAt")) / 86400.0 / 90) AS w
  FROM "Article" a
  WHERE a.status = 'Published'
    AND a.availability = 'Public'
    AND NOT a.unlisted
    AND NOT a."tosViolation"
    AND a."publishedAt" > now() - interval '365 days'
    AND EXISTS (
      SELECT 1 FROM "TagsOnArticle" ta JOIN "Tag" t ON t.id = ta."tagId" AND t."isCategory"
      WHERE ta."articleId" = a.id AND t.name = 'story'
    )
), reactions AS (
  SELECT s.id, s."userId" AS author, ar."userId" AS reader, ar."createdAt"
  FROM story s
  JOIN "ArticleReaction" ar ON ar."articleId" = s.id
  WHERE ar."userId" <> s."userId"
    AND ar."userId" <> ALL({{metricExcludedUserIds}})
), readers AS (
  SELECT id, count(DISTINCT reader) AS readers
  FROM reactions
  GROUP BY id
), chapter AS (
  SELECT
    s."userId",
    s.w * (
      SQRT(COALESCE(r.readers, 0)) * 7
      + SQRT(GREATEST(am."commentCount", 0)) * 10
      + SQRT(GREATEST(am."collectedCount", 0)) * 5
      + SQRT(GREATEST(am."viewCount", 0)) / 4
    ) AS v
  FROM story s
  JOIN "ArticleMetric" am ON am."articleId" = s.id AND am.timeframe = 'AllTime'
  LEFT JOIN readers r ON r.id = s.id
), ranked AS (
  SELECT *, row_number() OVER (PARTITION BY "userId" ORDER BY v DESC) AS rn
  FROM chapter
), loyal AS (
  SELECT author AS "userId", count(*) AS loyal
  FROM (
    SELECT author, reader
    FROM reactions
    WHERE "createdAt" > now() - interval '90 days'
    GROUP BY 1, 2
    HAVING count(DISTINCT id) >= 3
  ) x
  GROUP BY 1
), cadence AS (
  SELECT "userId", count(DISTINCT date_trunc('week', "publishedAt")) AS weeks
  FROM story
  WHERE "publishedAt" > now() - interval '84 days'
  GROUP BY 1
), scores AS (
  SELECT
    k."userId",
    100 * (SUM(k.v) + 15 * SQRT(COALESCE(MAX(l.loyal), 0)))
      * (0.5 + 0.5 * LEAST(COALESCE(MAX(c.weeks), 0), 12) / 12.0) AS score,
    jsonb_build_object(
      'articles', count(*),
      'loyalReaders', COALESCE(MAX(l.loyal), 0),
      'activeWeeks', COALESCE(MAX(c.weeks), 0)
    ) AS metrics
  FROM ranked k
  LEFT JOIN loyal l ON l."userId" = k."userId"
  LEFT JOIN cadence c ON c."userId" = k."userId"
  WHERE k.rn <= 20
  GROUP BY k."userId"
)$q$),
  ('writer-guide', 3, 'Guide Writers',
   'Guides people keep reading and saving',
   E'Per guide: √(views) / 2 + √(bookmarks) × 12 + √(comments) × 4, counting only the past year''s views, bookmarks and comments\n---\nGuides of any age; each loses half its points every 365 days\nYour best 20 guides count\nYou need a guide published in the last 365 days',
$q$WITH guide AS (
  SELECT a.id, a."userId", a."publishedAt"
  FROM "Article" a
  WHERE a.status = 'Published'
    AND a.availability = 'Public'
    AND NOT a.unlisted
    AND NOT a."tosViolation"
    AND EXISTS (
      SELECT 1 FROM "TagsOnArticle" ta JOIN "Tag" t ON t.id = ta."tagId" AND t."isCategory"
      WHERE ta."articleId" = a.id
        AND t.name IN ('generation guide', 'video generation guide', 'training guide', 'tool guide',
                       'resource guide', 'workflows', 'data prep', 'comparative study', 'ML Research')
    )
), valued AS (
  SELECT
    g."userId",
    GREATEST(am."viewCount", 0) AS views,
    GREATEST(am."collectedCount", 0) AS bookmarks,
    POWER(0.5, EXTRACT(EPOCH FROM (now() - g."publishedAt")) / 86400.0 / 365) * (
      SQRT(GREATEST(am."viewCount", 0)) / 2
      + SQRT(GREATEST(am."collectedCount", 0)) * 12
      + SQRT(GREATEST(am."commentCount", 0)) * 4
    ) AS v
  FROM guide g
  JOIN "ArticleMetric" am ON am."articleId" = g.id AND am.timeframe = 'Year'
), ranked AS (
  SELECT *, row_number() OVER (PARTITION BY "userId" ORDER BY v DESC) AS rn
  FROM valued
), scores AS (
  SELECT
    "userId",
    100 * SUM(v) AS score,
    jsonb_build_object('articles', count(*), 'viewCount', SUM(views), 'bookmark', SUM(bookmarks)) AS metrics
  FROM ranked
  WHERE rn <= 20
    AND "userId" IN (SELECT "userId" FROM guide WHERE "publishedAt" > now() - interval '365 days')
  GROUP BY "userId"
  HAVING SUM(v) > 0
)$q$),
  ('writer-rising', 4, 'Rising Writers',
   'Writers who published their first article in the last 90 days',
   E'Per article: √(readers) × 10 + √(views) / 2\n---\nFirst article published in the last 90 days\nYour best 10 articles count, and you need 25 readers across all your articles\nRelease notes (only announcement, news or event categories) earn a quarter; your own reactions do not count',
$q$WITH newcomers AS (
  SELECT "userId"
  FROM "Article"
  WHERE status = 'Published' AND "publishedAt" IS NOT NULL
  GROUP BY "userId"
  HAVING MIN("publishedAt") > now() - interval '90 days'
), art AS (
  SELECT
    a.id,
    a."userId",
    GREATEST(am."viewCount", 0) AS views,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM "TagsOnArticle" ta JOIN "Tag" t ON t.id = ta."tagId" AND t."isCategory"
        WHERE ta."articleId" = a.id
      ) AND NOT EXISTS (
        SELECT 1 FROM "TagsOnArticle" ta JOIN "Tag" t ON t.id = ta."tagId" AND t."isCategory"
        WHERE ta."articleId" = a.id AND t.name NOT IN ('announcement', 'news', 'event')
      ) THEN 0.25
      ELSE 1
    END AS k
  FROM "Article" a
  JOIN newcomers n ON n."userId" = a."userId"
  JOIN "ArticleMetric" am ON am."articleId" = a.id AND am.timeframe = 'AllTime'
  WHERE a.status = 'Published'
    AND a.availability = 'Public'
    AND NOT a.unlisted
    AND NOT a."tosViolation"
), reactions AS (
  SELECT x.id, x."userId" AS author, ar."userId" AS reader
  FROM art x
  JOIN "ArticleReaction" ar ON ar."articleId" = x.id
  WHERE ar."userId" <> x."userId"
    AND ar."userId" <> ALL({{metricExcludedUserIds}})
), readers AS (
  SELECT id, count(DISTINCT reader) AS readers
  FROM reactions
  GROUP BY id
), audience AS (
  SELECT author AS "userId", count(DISTINCT reader) AS readers
  FROM reactions
  GROUP BY 1
), valued AS (
  SELECT
    x."userId",
    x.k * (SQRT(COALESCE(r.readers, 0)) * 10 + SQRT(x.views) / 2) AS v
  FROM art x
  LEFT JOIN readers r ON r.id = x.id
), ranked AS (
  SELECT *, row_number() OVER (PARTITION BY "userId" ORDER BY v DESC) AS rn
  FROM valued
), scores AS (
  SELECT
    k."userId",
    100 * SUM(k.v) AS score,
    jsonb_build_object('articles', count(*), 'readers', MAX(au.readers)) AS metrics
  FROM ranked k
  JOIN audience au ON au."userId" = k."userId"
  WHERE k.rn <= 10
  GROUP BY k."userId"
  HAVING MAX(au.readers) >= 25
)$q$)
) AS v(id, ord, title, description, scoring, query)
ON CONFLICT (id) DO NOTHING;
