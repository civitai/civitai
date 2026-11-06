-- Moderator app: /models/rule-matches is the queue of model-rule text-scan holds. It is granted on its own
-- path, so copy the grants of the model-flag review queue (/models/flags/needs-review); otherwise only
-- moderator:admin can open it. Striking from it also needs the `user.strike` permission.
--
-- HAND-APPLIED. Safe to run BEFORE the moderator release (applyGrants ignores paths not in NAVIGATION).
-- Idempotent (ON CONFLICT DO NOTHING), so re-running never overwrites a grant edited on /admin since.

INSERT INTO "AppPageAccess" ("app", "path", "roles", "updatedById", "updatedAt")
SELECT src."app", '/models/rule-matches', src."roles", src."updatedById", now()
FROM "AppPageAccess" src
WHERE src."app" = 'moderator' AND src."path" = '/models/flags/needs-review'
ON CONFLICT ("app", "path") DO NOTHING;
