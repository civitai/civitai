-- Story Writers leaderboard: a separate board for writers of articles in the 'story' article category,
-- with its own four badges. Data rows, not schema. Apply by hand; this repo does not run
-- prisma migrate deploy. Do not apply between 23:00 and 00:01 UTC (prepare-leaderboard /
-- deliver-leaderboard-cosmetics). The first standings appear on the next prepare-leaderboard run.
--
-- The scoring is the writer board's query with two changes: only story-category articles count,
-- and bookmarks weigh 4 instead of 10 (views 1 instead of 0.5), because story readers bookmark less
-- than readers of guides. The user and article filters are copied from writer, including
-- `not a.nsfw`, so both boards change together if that filter is fixed.
--
-- The board's display flags (active, public, domain) are copied from writer, so it shows wherever
-- writer shows. Badge rows copy writer's badge type, source, unlock rule and art.
-- PLACEHOLDER ART: the four badges reuse the writer badges' images (Cosmetic.data) until the
-- story badge art is approved; swap it with an UPDATE on these four rows.
--
-- Idempotent: a re-run inserts nothing and passes its post-checks.

BEGIN;

DO $$
DECLARE
  w "Leaderboard"%ROWTYPE;
  badge_count int;
BEGIN
  SELECT * INTO w FROM "Leaderboard" WHERE id = 'writer';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'writer leaderboard row not found - the story board copies its display flags';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "Tag" t
    JOIN "TagsOnTags" tt ON tt."toTagId" = t.id
    JOIN "Tag" p ON p.id = tt."fromTagId"
    WHERE t.name = 'story' AND p.name = 'article category'
  ) THEN
    RAISE EXCEPTION 'no ''story'' tag under the ''article category'' system tag - the board would score nobody';
  END IF;

  INSERT INTO "Leaderboard" (id, index, title, description, "scoringDescription", query, active, public, domain)
  VALUES (
    'story-writer',
    w.index + 1,
    'Story Writers',
    'Top writers of story articles',
    'Score = (sqrt(views) * 1 + sqrt(reactions) * 7 + sqrt(bookmarks) * 4) * 100, summed over your story articles' || chr(10)
      || '---' || chr(10)
      || 'Story articles published in the last 30 days',
    $query$SELECT
  u.id as "userId",
  (
    sqrt(greatest(sum(am."viewCount"),1)) * 1 +
    sqrt(greatest(SUM(am."likeCount" + am."heartCount" + am."laughCount" + am."cryCount"),1)) * 7 +
    sqrt(greatest(SUM(am."collectedCount"),1)) * 4
  ) * 100 as score,
  jsonb_build_object(
    'viewCount', SUM(am."viewCount"),
    'bookmark', SUM(am."collectedCount"),
    'reactionCount', SUM(am."likeCount" + am."heartCount" + am."laughCount" + am."cryCount")
  ) as metrics
FROM "ArticleMetric" am
JOIN "Article" a ON a.id = am."articleId"
JOIN "User" u ON u.id = a."userId"
WHERE
  am.timeframe = 'AllTime'
  AND a.status = 'Published'
  AND a."publishedAt" BETWEEN current_date - INTERVAL '30 days' AND now()
  AND u."deletedAt" IS NULL AND u.id > 0
  AND not a.nsfw
  AND EXISTS (
    SELECT 1 FROM "TagsOnArticle" ta
    JOIN "Tag" t ON t.id = ta."tagId" AND t.name = 'story'
    JOIN "TagsOnTags" tt ON tt."toTagId" = t.id
    JOIN "Tag" p ON p.id = tt."fromTagId" AND p.name = 'article category'
    WHERE ta."articleId" = a.id
  )
GROUP BY u.id$query$,
    w.active,
    w.public,
    w.domain
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO "Cosmetic" (name, description, type, source, "permanentUnlock", data, "leaderboardId", "leaderboardPosition")
  SELECT
    tier.name,
    'Awarded for being in the top ' || tier.story_position || ' of the Story Writers leaderboard',
    c.type,
    c.source,
    c."permanentUnlock",
    c.data,
    'story-writer',
    tier.story_position
  FROM (VALUES
    (1, 1, 'Diamond Storyteller'),
    (3, 3, 'Gold Storyteller'),
    (10, 10, 'Silver Storyteller'),
    (100, 25, 'Bronze Storyteller')
  ) AS tier(writer_position, story_position, name)
  JOIN "Cosmetic" c ON c."leaderboardId" = 'writer' AND c."leaderboardPosition" = tier.writer_position
  WHERE NOT EXISTS (
    SELECT 1 FROM "Cosmetic" x
    WHERE x."leaderboardId" = 'story-writer' AND x."leaderboardPosition" = tier.story_position
  );

  SELECT count(*) INTO badge_count FROM "Cosmetic" WHERE "leaderboardId" = 'story-writer';
  IF badge_count <> 4 THEN
    RAISE EXCEPTION 'expected 4 story-writer badges, found % - a writer badge tier (1, 3, 10, 100) is missing', badge_count;
  END IF;
END $$;

COMMIT;
