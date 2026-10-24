-- Moderator app: /csam/text-holds is the queue of pending csam text-scan holds. It is granted on its own
-- path, so copy the grants of the image CSAM queue (/images/csam); otherwise only moderator:admin can
-- open it. Viewing and dismissing holds also need the `csam.report.file` permission.
--
-- HAND-APPLIED. Safe to run BEFORE the moderator release (applyGrants ignores paths not in NAVIGATION).
-- Idempotent (ON CONFLICT DO NOTHING), so re-running never overwrites a grant edited on /admin since.

INSERT INTO "AppPageAccess" ("app", "path", "roles", "updatedById", "updatedAt")
SELECT src."app", '/csam/text-holds', src."roles", src."updatedById", now()
FROM "AppPageAccess" src
WHERE src."app" = 'moderator' AND src."path" = '/images/csam'
ON CONFLICT ("app", "path") DO NOTHING;
