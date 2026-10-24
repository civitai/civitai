-- Moderator app: Minor Hash Matches, Model Flag Appeals and Held Detections became the three tabs of
-- Models -> Model Flags, grouped by whether a flag is applied:
--   /models/flags/appeals       owner disputes a flag             <- /models/flag-appeals
--   /models/flags/auto          flag applied: confirm or revert   <- /models/held-detections + /models/minor-hash-matches
--   /models/flags/needs-review  not applied: flag or dismiss      <- /models/held-detections + /models/minor-hash-matches
-- Needs review lists two kinds of lead, each ruled under its own permission (rows keyed `grant:<id>`):
--   grant:modelFlags.detections.decide   held text-scan detections  <- /models/held-detections + /models/minor-hash-matches
--   grant:modelFlags.fileMatches.decide  file matches               <- /models/minor-hash-matches
-- Each tab and permission copies the grants of the pages it comes from; otherwise only moderator:admin
-- reaches them.
--
-- An earlier draft of this migration (tabs /models/flags/review and /models/flags/matches) was hand-applied
-- on dev only. Its rows count as sources here too, so re-applying this on dev carries any role edited on
-- /admin since, and the last statement removes the two retired paths.
--
-- HAND-APPLIED. Apply BEFORE the release that ships the Model Flags section: the old paths stop being
-- navigable with it, so until this has run existing reviewers lose the queues. The legacy rows are left in
-- place so a rollback of the release keeps working.
-- Idempotent (ON CONFLICT DO NOTHING), so re-running never overwrites a grant edited on /admin since.

INSERT INTO "AppPageAccess" ("app", "path", "roles", "updatedById", "updatedAt")
SELECT src."app", '/models/flags/appeals', src."roles", src."updatedById", now()
FROM "AppPageAccess" src
WHERE src."app" = 'moderator' AND src."path" = '/models/flag-appeals'
ON CONFLICT ("app", "path") DO NOTHING;

-- One row per target, each the union of the roles on its sources.
INSERT INTO "AppPageAccess" ("app", "path", "roles", "updatedById", "updatedAt")
SELECT
  'moderator',
  t."path",
  array(
    SELECT DISTINCT role
    FROM "AppPageAccess" src, unnest(src."roles") AS role
    WHERE src."app" = 'moderator' AND src."path" = ANY (t."sources")
    ORDER BY role
  ),
  (
    SELECT src."updatedById"
    FROM "AppPageAccess" src
    WHERE src."app" = 'moderator' AND src."path" = ANY (t."sources")
    ORDER BY src."updatedAt" DESC
    LIMIT 1
  ),
  now()
FROM (
  VALUES
    ('/models/flags/auto',
     ARRAY['/models/held-detections', '/models/minor-hash-matches', '/models/flags/review']),
    ('/models/flags/needs-review',
     ARRAY['/models/held-detections', '/models/minor-hash-matches', '/models/flags/review',
           '/models/flags/matches']),
    ('grant:modelFlags.detections.decide',
     ARRAY['/models/held-detections', '/models/minor-hash-matches', '/models/flags/review']),
    ('grant:modelFlags.fileMatches.decide',
     ARRAY['/models/minor-hash-matches', '/models/flags/matches'])
) AS t("path", "sources")
WHERE EXISTS (
  SELECT 1
  FROM "AppPageAccess" src
  WHERE src."app" = 'moderator' AND src."path" = ANY (t."sources")
)
ON CONFLICT ("app", "path") DO NOTHING;

-- Dev only: the earlier draft's tabs. Prod never had these rows, so this deletes nothing there.
DELETE FROM "AppPageAccess"
WHERE "app" = 'moderator' AND "path" IN ('/models/flags/review', '/models/flags/matches');
