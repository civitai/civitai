-- Video creator leaderboard (ClickUp 868ktjte4).
-- Data rows, not schema. Apply by hand; this repo does not run prisma migrate deploy.
--
-- Staged deliberately as active = true, public = false: prepare-leaderboard only populates
-- active boards, and public = false hides it from everyone but moderators. Flip public to
-- true once the populated rows have been checked.
--
-- The query is the images-overall board's query with one added filter, ic.mediaType = 'video'.
-- The CTE name must keep the ch_image_scores prefix: prepare-leaderboard routes on that string
-- to the ClickHouse batching path, and a rename silently sends the board down the Postgres path.

INSERT INTO "Leaderboard" (id, index, title, description, "scoringDescription", query, active, public)
SELECT 'videos-overall', 19, 'Master Generators (Video)',
       'Creators that have made the most popular safe-for-work (PG, PG-13) videos',
       E'√(reactions)\r\n---\r\nDiminishing returns up to 120 entries',
$q$WITH ch_image_scores AS (
  SELECT
      ic.id as "imageId",
      ic.userId as userId,
      max(1 - min2(1 * pow(age('day',now(),ic."createdAt")/30, 2), 1)) as ageMultiplier,
      sum(r.metricValue) as reactions,
      max2(reactions * ageMultiplier, 0) as score,
      toJSONString(map('reactionCount', max2(reactions, 0))) as "metrics"
    FROM (
      SELECT entityId, userId, createdAt, argMax(metricValue, version) AS metricValue
      FROM entityMetricEvents_month
      WHERE entityType = 'Image'
        AND entityId BETWEEN {from: Int32} AND {to: Int32}
        AND createdAt > NOW() - INTERVAL '30 days'
        AND metricType IN ('Like','Heart','Cry','Laugh','ReactionLike','ReactionHeart','ReactionCry','ReactionLaugh')
      GROUP BY entityType, entityId, metricType, userId, createdAt
    ) r
    JOIN images_created ic ON ic.id = r.entityId
    WHERE ic.id BETWEEN {from: Int32} AND {to: Int32}
      AND ic.mediaType = 'video'
      AND ic.nsfwLevel IN ('PG', 'PG13')
    GROUP BY 1, 2
)
SELECT * FROM ch_image_scores ORDER BY score DESC
SETTINGS max_memory_usage = 5000000000;$q$,
       true, false
WHERE NOT EXISTS (SELECT 1 FROM "Leaderboard" WHERE id = 'videos-overall');

-- Tier badges. Uploaded to the CDN 2026-08-24; each uuid verified 200 image/png at
-- https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/<uuid>/original=true
-- One statement over a VALUES list rather than four inserts: Cosmetic has no unique key to
-- conflict on, and a loop would report a partial insert as success.
INSERT INTO "Cosmetic" (name, description, type, source, "permanentUnlock", data, "leaderboardId", "leaderboardPosition", "createdAt")
SELECT v.name, v.description, 'Badge'::"CosmeticType", 'Trophy'::"CosmeticSource", false, v.data::jsonb, 'videos-overall', v.position, now()
FROM (VALUES
  ('Diamond Video Generator Badge', 'Awarded for being in the top 1 of the Video Generator leaderboard',   '{"url":"48e171a8-f7ba-4142-ac5f-2823cdfdcbc1"}', 1),
  ('Gold Video Generator Badge',    'Awarded for being in the top 3 of the Video Generator leaderboard',   '{"url":"073711f3-e2c5-4a00-a96a-fb33b25e00ee"}', 3),
  ('Silver Video Generator Badge',  'Awarded for being in the top 10 of the Video Generator leaderboard',  '{"url":"a852dfad-9570-47f7-99af-2d7bcb4a2ce4"}', 10),
  ('Bronze Video Generator Badge',  'Awarded for being in the top 100 of the Video Generator leaderboard', '{"url":"fa3e3011-2f6d-4266-9f26-337c07a706c7"}', 100)
) AS v(name, description, data, position)
WHERE NOT EXISTS (
  SELECT 1 FROM "Cosmetic" c
  WHERE c."leaderboardId" = 'videos-overall' AND c."leaderboardPosition" = v.position
);

-- Verify before moving on: expects one row, count 4, positions {1,3,10,100}.
-- SELECT count(*), array_agg("leaderboardPosition" ORDER BY "leaderboardPosition")
-- FROM "Cosmetic" WHERE "leaderboardId" = 'videos-overall';

-- Homeblock strip (HomeBlock id 4). Prepends at one below the current lowest index (-4 -> -5).
-- Run this only once the board is public; it is the step that shows the strip to everyone.
UPDATE "HomeBlock"
SET metadata = jsonb_set(metadata, '{leaderboards}',
  ('[{"id":"videos-overall","index":-5}]'::jsonb) || (metadata->'leaderboards'))
WHERE id = 4
  AND NOT metadata->'leaderboards' @> '[{"id":"videos-overall"}]'::jsonb;
