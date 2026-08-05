-- Replace the "New & Upcoming Creators" leaderboard block with two Feed blocks.
--
-- The board is the creator SELECTOR; what belongs on the home page is the creators'
-- actual work. `newCreators` resolves the same board server-side, so these render the
-- most-reacted content of the last week from exactly the creators the board picked —
-- and clicking through lands on the same filter.
DELETE FROM "HomeBlock"
WHERE "userId" = -1
  AND type = 'Leaderboard'
  AND metadata->>'title' = 'New & Upcoming Creators';

INSERT INTO "HomeBlock" ("createdAt", "updatedAt", "userId", index, type, metadata, permanent, "sourceId")
SELECT now(), now(), -1, 4, 'Feed', '{
  "title": "New & Upcoming Creators",
  "description": "Popular work from creators who just got started",
  "link": "/images?newCreators=true",
  "linkText": "Browse their work",
  "feed": {
    "entity": "images",
    "newCreators": true,
    "sort": "Most Reactions",
    "period": "Week",
    "limit": 42,
    "rows": 2,
    "maxPerUser": 2
  }
}'::jsonb, false, NULL
WHERE NOT EXISTS (
  SELECT 1 FROM "HomeBlock"
  WHERE "userId" = -1 AND type = 'Feed' AND metadata->>'title' = 'New & Upcoming Creators'
);

INSERT INTO "HomeBlock" ("createdAt", "updatedAt", "userId", index, type, metadata, permanent, "sourceId")
SELECT now(), now(), -1, 5, 'Feed', '{
  "title": "New & Upcoming Model Creators",
  "description": "Popular models from creators who just got started",
  "link": "/models?newCreators=true",
  "linkText": "Browse their models",
  "feed": {
    "entity": "models",
    "newCreators": true,
    "sort": "Highest Rated",
    "period": "Week",
    "limit": 42,
    "rows": 1,
    "maxPerUser": 2
  }
}'::jsonb, false, NULL
WHERE NOT EXISTS (
  SELECT 1 FROM "HomeBlock"
  WHERE "userId" = -1 AND type = 'Feed' AND metadata->>'title' = 'New & Upcoming Model Creators'
);
