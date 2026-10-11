-- Moderator app: Scam Restrictions moved from Audit to /users/scam-restrictions, and Model Flag Appeals
-- moved from a tab of Minor Hash Matches to /models/flag-appeals. Each new page is granted on its own
-- path, so copy the grants of the page it was split from; otherwise only moderator:admin can open it.
--
-- HAND-APPLIED. Safe to run BEFORE the moderator release (applyGrants ignores paths not in NAVIGATION),
-- so run it before or right after the release; until it has run, existing reviewers lose these two pages.
-- Idempotent (ON CONFLICT DO NOTHING), so re-running never overwrites a grant edited on /admin since.

INSERT INTO "AppPageAccess" ("app", "path", "roles", "updatedById", "updatedAt")
SELECT src."app", '/models/flag-appeals', src."roles", src."updatedById", now()
FROM "AppPageAccess" src
WHERE src."app" = 'moderator' AND src."path" = '/models/minor-hash-matches'
ON CONFLICT ("app", "path") DO NOTHING;

INSERT INTO "AppPageAccess" ("app", "path", "roles", "updatedById", "updatedAt")
SELECT src."app", '/users/scam-restrictions', src."roles", src."updatedById", now()
FROM "AppPageAccess" src
WHERE src."app" = 'moderator' AND src."path" = '/audit/generator-restrictions'
ON CONFLICT ("app", "path") DO NOTHING;
