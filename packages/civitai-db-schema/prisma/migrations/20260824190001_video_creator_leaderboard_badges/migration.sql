-- Video creator leaderboard, step 2 of 2 (ClickUp 868ktjte4).
-- Apply by hand, and only AFTER "Leaderboard".public is true for videos-overall.
-- deliver-leaderboard-cosmetics (00:01 UTC) awards these to whoever is in the top 100 of the
-- board's current results with no regard for public or active, so applying this early hands
-- badges to users while the board is still being checked.
--
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
