-- Moderator app: Minor Hash Matches, Model Flag Appeals and Held Detections became the three tabs of
-- Models -> Model Flags (/models/flags/{appeals,review,matches}). Each tab is granted on its own path, so
-- copy the grants of the pages they come from; otherwise only moderator:admin can open them.
--   appeals <- /models/flag-appeals
--   review  <- union of /models/held-detections and /models/minor-hash-matches
--   matches <- /models/minor-hash-matches
--
-- HAND-APPLIED. Apply BEFORE the release that ships the Model Flags section: the old paths stop being
-- navigable with it, so until this has run existing reviewers lose the queues. The old rows are left in
-- place so a rollback of the release keeps working.
-- Idempotent (ON CONFLICT DO NOTHING), so re-running never overwrites a grant edited on /admin since.

INSERT INTO "AppPageAccess" ("app", "path", "roles", "updatedById", "updatedAt")
SELECT src."app", '/models/flags/appeals', src."roles", src."updatedById", now()
FROM "AppPageAccess" src
WHERE src."app" = 'moderator' AND src."path" = '/models/flag-appeals'
ON CONFLICT ("app", "path") DO NOTHING;

INSERT INTO "AppPageAccess" ("app", "path", "roles", "updatedById", "updatedAt")
SELECT
  'moderator',
  '/models/flags/review',
  array(
    SELECT DISTINCT role
    FROM "AppPageAccess" src, unnest(src."roles") AS role
    WHERE src."app" = 'moderator'
      AND src."path" IN ('/models/held-detections', '/models/minor-hash-matches')
  ),
  (
    SELECT src."updatedById"
    FROM "AppPageAccess" src
    WHERE src."app" = 'moderator'
      AND src."path" IN ('/models/held-detections', '/models/minor-hash-matches')
    ORDER BY src."updatedAt" DESC
    LIMIT 1
  ),
  now()
WHERE EXISTS (
  SELECT 1
  FROM "AppPageAccess" src
  WHERE src."app" = 'moderator'
    AND src."path" IN ('/models/held-detections', '/models/minor-hash-matches')
)
ON CONFLICT ("app", "path") DO NOTHING;

INSERT INTO "AppPageAccess" ("app", "path", "roles", "updatedById", "updatedAt")
SELECT src."app", '/models/flags/matches', src."roles", src."updatedById", now()
FROM "AppPageAccess" src
WHERE src."app" = 'moderator' AND src."path" = '/models/minor-hash-matches'
ON CONFLICT ("app", "path") DO NOTHING;
