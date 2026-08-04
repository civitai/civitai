-- "New & Upcoming Creators" system home block.
--
-- All four board ids are listed. `getLeaderboardsWithResults` filters by the
-- request domain, so green/blue render the two SFW boards and red renders the two
-- mature ones from this single block — no per-domain home block needed.
--
-- `moreHref` sends the card's "More" button into the pre-filtered feed rather than
-- the board's own page: browsing what these creators are posting is the point,
-- the ranking is just how they got selected.
INSERT INTO "HomeBlock" ("createdAt", "updatedAt", "userId", index, type, metadata, permanent, "sourceId")
VALUES (
  now(),
  now(),
  -1,
  4,
  'Leaderboard',
  '{
    "title": "New & Upcoming Creators",
    "description": "Creators who just got started and are already making great work",
    "link": "/images?newCreators=true",
    "linkText": "Browse their work",
    "leaderboards": [
      { "id": "images-new", "index": 0, "moreHref": "/images?newCreators=true" },
      { "id": "images-new-red", "index": 0, "moreHref": "/images?newCreators=true" },
      { "id": "new_creators", "index": 1, "moreHref": "/models?newCreators=true" },
      { "id": "new_creators-red", "index": 1, "moreHref": "/models?newCreators=true" }
    ]
  }'::jsonb,
  false,
  NULL
);

-- The catch-all "Top Creators" block still lists these two boards; drop them so a
-- creator isn't shown twice on the same page.
UPDATE "HomeBlock"
SET metadata = jsonb_set(
  metadata,
  '{leaderboards}',
  (
    SELECT COALESCE(jsonb_agg(board), '[]'::jsonb)
    FROM jsonb_array_elements(metadata->'leaderboards') board
    WHERE board->>'id' NOT IN ('new_creators', 'images-new')
  )
)
WHERE "userId" = -1
  AND type = 'Leaderboard'
  AND metadata->>'title' = 'Top Creators';
