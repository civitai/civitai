-- Writer leaderboards: Active Writers, Guide Writers, Rising Writers, Community Builders. Data rows, not schema. Apply by hand.
-- Based on civitai/civitai#6556. Stories have their own board already (story-writer).
-- An article's categories are its system category (Article."systemCategoryId") when it has one, and the
-- categories its author picked (tags under the 'article category' system tag) only when it has none.
-- Articles count under the same gates as the Writers and Story Writers boards: published, scanned, rated
-- (any level; unrated never), not Private, unlisted or a ToS violation, by an owner neither deleted nor
-- banned. The boards take the Writers board's domain.
-- Inserted inactive and non-public: updateLegendsBoardResults scores every populated board regardless of the
-- public flag, so populating before review hands out Legendary Nameplates. To go live, run each
-- query read-only, then set active = true and public = true together, not between 23:00 and 00:05 UTC
-- (prepare-leaderboard reads active boards at 23:00; update-user-leaderboard-rank checks at 00:01).
-- Activate only once the build that replaces {{metricExcludedUserIds}} is deployed: before it the token is a
-- syntax error, and one failing board stops the whole nightly run, Legends and the cache purge included.
-- Queries end in a `scores` CTE with no final SELECT (the job appends one) and may use {{metricExcludedUserIds}}.
-- Readers and participants are computed from ArticleReaction/CommentV2 rather than read from ArticleMetric,
-- whose reaction and comment counts include the author. ArticleMetric is read only for its AllTime row; the
-- article metrics job writes no other timeframe.
--
-- ROLLBACK (deletes the four boards and what they produced: results, Legends rows, populated markers, and
-- ranks taken from them, which are rebuilt from the remaining public boards as leaderboardRankInsert in
-- user.service.ts does). Run it BEFORE reverting the job change: the reverted job would send the token to
-- Postgres unreplaced. To keep the
-- history instead, set active = false, public = false; Legends still counts a hidden board's past results.
-- Afterwards purge the `leaderboard` cache tag, or wait for clear-leaderboard-cache at midnight.
--   BEGIN;
--   SET LOCAL lock_timeout = '3s';
--   CREATE TEMP TABLE writer_boards ON COMMIT DROP AS
--     SELECT unnest(ARRAY['writer-active', 'writer-guide', 'writer-rising', 'writer-community']) AS id;
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM "Cosmetic" WHERE "leaderboardId" IN (SELECT id FROM writer_boards)) THEN
--       RAISE EXCEPTION 'writer board badges exist: roll back their migration first';
--     END IF;
--   END $$;
--   CREATE TEMP TABLE writer_rank_users ON COMMIT DROP AS
--     SELECT "userId" FROM "UserRank" WHERE "leaderboardId" IN (SELECT id FROM writer_boards);
--   DELETE FROM "UserRank" WHERE "userId" IN (SELECT "userId" FROM writer_rank_users);
--   DELETE FROM "LegendsBoardResult" WHERE "leaderboardId" IN (SELECT id FROM writer_boards);
--   DELETE FROM "KeyValue" WHERE key IN (SELECT 'leaderboard:populated:' || id FROM writer_boards);
--   DELETE FROM "Leaderboard" WHERE id IN (SELECT id FROM writer_boards);
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

INSERT INTO "Leaderboard" (id, index, title, description, "scoringDescription", query, active, public, domain)
SELECT v.id, (SELECT max(index) FROM "Leaderboard") + v.ord, v.title, v.description, v.scoring, v.query, false, false,
  COALESCE((SELECT domain FROM "Leaderboard" WHERE id = 'writer'), '{all}')
FROM (VALUES
  ('writer-active', 1, 'Active Writers',
   'Writers publishing now, scored article by article',
   E'Per article: √(views) / 2 + √(readers) × 7 + √(bookmarks) × 10 + √(participants) × 5\n---\nArticles from the last 365 days; each loses half its points every 90 days\nYour best 30 articles count\nReaders and participants are people other than you who reacted or commented, each counted once\nRelease notes (only announcement, news or event categories) earn a quarter',
$q$WITH article AS (
  SELECT
    a.id,
    a."userId",
    GREATEST(am."viewCount", 0) AS views,
    GREATEST(am."collectedCount", 0) AS bookmarks,
    POWER(0.5, EXTRACT(EPOCH FROM (now() - a."publishedAt")) / 86400.0 / 90) AS w,
    CASE
      WHEN cardinality(CASE
        WHEN a."systemCategoryId" IS NOT NULL THEN ARRAY(SELECT t.name FROM "Tag" t WHERE t.id = a."systemCategoryId")
        ELSE ARRAY(
          SELECT t.name FROM "TagsOnArticle" ta
          JOIN "Tag" t ON t.id = ta."tagId"
          JOIN "TagsOnTags" tt ON tt."toTagId" = t.id
          JOIN "Tag" p ON p.id = tt."fromTagId" AND p.name = 'article category'
          WHERE ta."articleId" = a.id
        )
      END) > 0
        AND CASE
          WHEN a."systemCategoryId" IS NOT NULL THEN ARRAY(SELECT t.name FROM "Tag" t WHERE t.id = a."systemCategoryId")
          ELSE ARRAY(
            SELECT t.name FROM "TagsOnArticle" ta
            JOIN "Tag" t ON t.id = ta."tagId"
            JOIN "TagsOnTags" tt ON tt."toTagId" = t.id
            JOIN "Tag" p ON p.id = tt."fromTagId" AND p.name = 'article category'
            WHERE ta."articleId" = a.id
          )
        END <@ ARRAY['announcement', 'news', 'event']
      THEN 0.25
      ELSE 1
    END AS k
  FROM "Article" a
  JOIN "ArticleMetric" am ON am."articleId" = a.id AND am.timeframe = 'AllTime'
  WHERE a.status = 'Published'
    AND a.ingestion = 'Scanned'
    AND a.availability <> 'Private'
    AND NOT a.unlisted
    AND NOT a."tosViolation"
    AND a."nsfwLevel" <> 0
    AND EXISTS (
      SELECT 1 FROM "User" u
      WHERE u.id = a."userId" AND u."deletedAt" IS NULL AND u."bannedAt" IS NULL AND u.id > 0
    )
    AND a."publishedAt" > now() - interval '365 days'
), readers AS (
  SELECT x.id, count(DISTINCT ar."userId") AS readers
  FROM article x
  JOIN "ArticleReaction" ar ON ar."articleId" = x.id
  WHERE ar."userId" <> x."userId"
    AND ar."userId" <> ALL({{metricExcludedUserIds}})
  GROUP BY x.id
), threads AS (
  SELECT x.id, x."userId", root.id AS thread_id
  FROM article x JOIN "Thread" root ON root."articleId" = x.id
  UNION ALL
  SELECT x.id, x."userId", t.id
  FROM article x JOIN "Thread" root ON root."articleId" = x.id JOIN "Thread" t ON t."rootThreadId" = root.id
), participants AS (
  SELECT th.id, count(DISTINCT c."userId") AS participants
  FROM threads th
  JOIN "CommentV2" c ON c."threadId" = th.thread_id
  WHERE NOT c."tosViolation"
    AND c.hidden IS NOT TRUE
    AND c."userId" <> th."userId"
    AND c."userId" <> ALL({{metricExcludedUserIds}})
  GROUP BY th.id
), valued AS (
  SELECT
    x.*,
    COALESCE(rd.readers, 0) AS readers,
    COALESCE(p.participants, 0) AS participants,
    x.w * x.k * (
      SQRT(x.views) / 2
      + SQRT(COALESCE(rd.readers, 0)) * 7
      + SQRT(x.bookmarks) * 10
      + SQRT(COALESCE(p.participants, 0)) * 5
    ) AS v
  FROM article x
  LEFT JOIN readers rd ON rd.id = x.id
  LEFT JOIN participants p ON p.id = x.id
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
      'readers', SUM(readers),
      'bookmark', SUM(bookmarks),
      'participants', SUM(participants)
    ) AS metrics
  FROM ranked
  WHERE rn <= 30
  GROUP BY "userId"
)$q$),
  ('writer-guide', 2, 'Guide Writers',
   'Guides people keep reading and saving',
   E'Per guide: √(views) / 2 + √(bookmarks) × 12 + √(participants) × 4, counting only the past year''s comments\n---\nGuides of any age; each loses half its points every 365 days\nYour best 20 guides count\nParticipants: people other than you who commented, each counted once\nYou need a guide published in the last 365 days',
$q$WITH guide AS (
  SELECT a.id, a."userId", a."publishedAt"
  FROM "Article" a
  WHERE a.status = 'Published'
    AND a.ingestion = 'Scanned'
    AND a.availability <> 'Private'
    AND NOT a.unlisted
    AND NOT a."tosViolation"
    AND a."nsfwLevel" <> 0
    AND EXISTS (
      SELECT 1 FROM "User" u
      WHERE u.id = a."userId" AND u."deletedAt" IS NULL AND u."bannedAt" IS NULL AND u.id > 0
    )
    AND CASE
      WHEN a."systemCategoryId" IS NOT NULL THEN ARRAY(SELECT t.name FROM "Tag" t WHERE t.id = a."systemCategoryId")
      ELSE ARRAY(
        SELECT t.name FROM "TagsOnArticle" ta
        JOIN "Tag" t ON t.id = ta."tagId"
        JOIN "TagsOnTags" tt ON tt."toTagId" = t.id
        JOIN "Tag" p ON p.id = tt."fromTagId" AND p.name = 'article category'
        WHERE ta."articleId" = a.id
      )
    END && ARRAY['generation guide', 'video generation guide', 'training guide', 'tool guide',
                 'resource guide', 'workflows', 'data prep', 'comparative study', 'ML Research']
), threads AS (
  SELECT g.id, g."userId", root.id AS thread_id
  FROM guide g JOIN "Thread" root ON root."articleId" = g.id
  UNION ALL
  SELECT g.id, g."userId", t.id
  FROM guide g JOIN "Thread" root ON root."articleId" = g.id JOIN "Thread" t ON t."rootThreadId" = root.id
), participants AS (
  SELECT th.id, count(DISTINCT c."userId") AS participants
  FROM threads th
  JOIN "CommentV2" c ON c."threadId" = th.thread_id
  WHERE NOT c."tosViolation"
    AND c.hidden IS NOT TRUE
    AND c."createdAt" > now() - interval '365 days'
    AND c."userId" <> th."userId"
    AND c."userId" <> ALL({{metricExcludedUserIds}})
  GROUP BY th.id
), valued AS (
  SELECT
    g."userId",
    GREATEST(am."viewCount", 0) AS views,
    GREATEST(am."collectedCount", 0) AS bookmarks,
    POWER(0.5, EXTRACT(EPOCH FROM (now() - g."publishedAt")) / 86400.0 / 365) * (
      SQRT(GREATEST(am."viewCount", 0)) / 2
      + SQRT(GREATEST(am."collectedCount", 0)) * 12
      + SQRT(COALESCE(p.participants, 0)) * 4
    ) AS v
  FROM guide g
  JOIN "ArticleMetric" am ON am."articleId" = g.id AND am.timeframe = 'AllTime'
  LEFT JOIN participants p ON p.id = g.id
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
  ('writer-rising', 3, 'Rising Writers',
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
      WHEN cardinality(CASE
        WHEN a."systemCategoryId" IS NOT NULL THEN ARRAY(SELECT t.name FROM "Tag" t WHERE t.id = a."systemCategoryId")
        ELSE ARRAY(
          SELECT t.name FROM "TagsOnArticle" ta
          JOIN "Tag" t ON t.id = ta."tagId"
          JOIN "TagsOnTags" tt ON tt."toTagId" = t.id
          JOIN "Tag" p ON p.id = tt."fromTagId" AND p.name = 'article category'
          WHERE ta."articleId" = a.id
        )
      END) > 0
        AND CASE
          WHEN a."systemCategoryId" IS NOT NULL THEN ARRAY(SELECT t.name FROM "Tag" t WHERE t.id = a."systemCategoryId")
          ELSE ARRAY(
            SELECT t.name FROM "TagsOnArticle" ta
            JOIN "Tag" t ON t.id = ta."tagId"
            JOIN "TagsOnTags" tt ON tt."toTagId" = t.id
            JOIN "Tag" p ON p.id = tt."fromTagId" AND p.name = 'article category'
            WHERE ta."articleId" = a.id
          )
        END <@ ARRAY['announcement', 'news', 'event']
      THEN 0.25
      ELSE 1
    END AS k
  FROM "Article" a
  JOIN newcomers n ON n."userId" = a."userId"
  JOIN "ArticleMetric" am ON am."articleId" = a.id AND am.timeframe = 'AllTime'
  WHERE a.status = 'Published'
    AND a.ingestion = 'Scanned'
    AND a.availability <> 'Private'
    AND NOT a.unlisted
    AND NOT a."tosViolation"
    AND a."nsfwLevel" <> 0
    AND EXISTS (
      SELECT 1 FROM "User" u
      WHERE u.id = a."userId" AND u."deletedAt" IS NULL AND u."bannedAt" IS NULL AND u.id > 0
    )
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
)$q$),
  ('writer-community', 4, 'Community Builders',
   'Articles that get other writers talking and writing',
   E'Per article: √(participants) × 6 + √(writers who answered with an article) × 20 + √(of them, first-time writers) × 10\n---\nArticles from the last 365 days; each loses half its points every 180 days\nYour best 10 articles count, and you need at least one answer\nAn answer is a later article by someone else that links to yours; each person counts once\nParticipants: people other than you who commented, each counted once\nRelease notes (only announcement, news or event categories) earn a quarter',
$q$WITH hosted AS (
  SELECT
    a.id,
    a."userId",
    a."publishedAt",
    POWER(0.5, EXTRACT(EPOCH FROM (now() - a."publishedAt")) / 86400.0 / 180) AS w,
    CASE
      WHEN cardinality(CASE
        WHEN a."systemCategoryId" IS NOT NULL THEN ARRAY(SELECT t.name FROM "Tag" t WHERE t.id = a."systemCategoryId")
        ELSE ARRAY(
          SELECT t.name FROM "TagsOnArticle" ta
          JOIN "Tag" t ON t.id = ta."tagId"
          JOIN "TagsOnTags" tt ON tt."toTagId" = t.id
          JOIN "Tag" p ON p.id = tt."fromTagId" AND p.name = 'article category'
          WHERE ta."articleId" = a.id
        )
      END) > 0
        AND CASE
          WHEN a."systemCategoryId" IS NOT NULL THEN ARRAY(SELECT t.name FROM "Tag" t WHERE t.id = a."systemCategoryId")
          ELSE ARRAY(
            SELECT t.name FROM "TagsOnArticle" ta
            JOIN "Tag" t ON t.id = ta."tagId"
            JOIN "TagsOnTags" tt ON tt."toTagId" = t.id
            JOIN "Tag" p ON p.id = tt."fromTagId" AND p.name = 'article category'
            WHERE ta."articleId" = a.id
          )
        END <@ ARRAY['announcement', 'news', 'event']
      THEN 0.25
      ELSE 1
    END AS k
  FROM "Article" a
  WHERE a.status = 'Published'
    AND a.ingestion = 'Scanned'
    AND a.availability <> 'Private'
    AND NOT a.unlisted
    AND NOT a."tosViolation"
    AND a."nsfwLevel" <> 0
    AND EXISTS (
      SELECT 1 FROM "User" u
      WHERE u.id = a."userId" AND u."deletedAt" IS NULL AND u."bannedAt" IS NULL AND u.id > 0
    )
    AND a."publishedAt" > now() - interval '365 days'
), threads AS (
  SELECT h.id, h."userId", root.id AS thread_id
  FROM hosted h JOIN "Thread" root ON root."articleId" = h.id
  UNION ALL
  SELECT h.id, h."userId", t.id
  FROM hosted h JOIN "Thread" root ON root."articleId" = h.id JOIN "Thread" t ON t."rootThreadId" = root.id
), participants AS (
  SELECT th.id, count(DISTINCT c."userId") AS participants
  FROM threads th
  JOIN "CommentV2" c ON c."threadId" = th.thread_id
  WHERE NOT c."tosViolation"
    AND c.hidden IS NOT TRUE
    AND c."userId" <> th."userId"
    AND c."userId" <> ALL({{metricExcludedUserIds}})
  GROUP BY th.id
), citations AS (
  SELECT DISTINCT a.id, a."userId", a."publishedAt", m[1]::int AS target
  FROM "Article" a, regexp_matches(a.content, '/articles/([0-9]{1,9})(?![0-9])', 'g') m
  WHERE a.status = 'Published'
    AND a.ingestion = 'Scanned'
    AND a.availability <> 'Private'
    AND NOT a.unlisted
    AND NOT a."tosViolation"
    AND a."nsfwLevel" <> 0
    AND EXISTS (
      SELECT 1 FROM "User" u
      WHERE u.id = a."userId" AND u."deletedAt" IS NULL AND u."bannedAt" IS NULL AND u.id > 0
    )
    AND a."publishedAt" > now() - interval '365 days'
    AND a."userId" <> ALL({{metricExcludedUserIds}})
), firsts AS (
  SELECT DISTINCT ON ("userId") "userId", id
  FROM "Article"
  WHERE status = 'Published' AND "publishedAt" IS NOT NULL
  ORDER BY "userId", "publishedAt", id
), answers AS (
  SELECT
    h.id,
    count(DISTINCT ci."userId") AS answers,
    count(DISTINCT ci."userId") FILTER (WHERE f.id = ci.id) AS first_timers
  FROM hosted h
  JOIN citations ci ON ci.target = h.id AND ci."userId" <> h."userId" AND ci."publishedAt" > h."publishedAt"
  LEFT JOIN firsts f ON f."userId" = ci."userId"
  GROUP BY h.id
), valued AS (
  SELECT
    h."userId",
    COALESCE(p.participants, 0) AS participants,
    COALESCE(an.answers, 0) AS answers,
    COALESCE(an.first_timers, 0) AS first_timers,
    h.w * h.k * (
      SQRT(COALESCE(p.participants, 0)) * 6
      + SQRT(COALESCE(an.answers, 0)) * 20
      + SQRT(COALESCE(an.first_timers, 0)) * 10
    ) AS v
  FROM hosted h
  LEFT JOIN participants p ON p.id = h.id
  LEFT JOIN answers an ON an.id = h.id
), ranked AS (
  SELECT *, row_number() OVER (PARTITION BY "userId" ORDER BY v DESC) AS rn
  FROM valued
), scores AS (
  SELECT
    "userId",
    100 * SUM(v) AS score,
    jsonb_build_object(
      'articles', count(*),
      'answers', SUM(answers),
      'firstTimers', SUM(first_timers),
      'participants', SUM(participants)
    ) AS metrics
  FROM ranked
  WHERE rn <= 10
  GROUP BY "userId"
  HAVING SUM(answers) > 0
)$q$)
) AS v(id, ord, title, description, scoring, query)
ON CONFLICT (id) DO NOTHING;
