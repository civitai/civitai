-- Moderator app: the Re-detected view moved from /models/flag-appeals to its own page,
-- /models/held-detections, which also lists first detections held for review. The new page is granted
-- on its own path, so copy the grants of the page it was split from; otherwise only moderator:admin can
-- open it.
--
-- HAND-APPLIED. Safe to run BEFORE the moderator release (applyGrants ignores paths not in NAVIGATION),
-- so run it before or right after the release; until it has run, existing reviewers lose the queue.
-- Idempotent (ON CONFLICT DO NOTHING), so re-running never overwrites a grant edited on /admin since.

INSERT INTO "AppPageAccess" ("app", "path", "roles", "updatedById", "updatedAt")
SELECT src."app", '/models/held-detections', src."roles", src."updatedById", now()
FROM "AppPageAccess" src
WHERE src."app" = 'moderator' AND src."path" = '/models/flag-appeals'
ON CONFLICT ("app", "path") DO NOTHING;
