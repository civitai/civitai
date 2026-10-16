-- Moderator app: striking or notifying an account, and removing, restoring or flagging images, were
-- gated on the /users PAGE grant. They are now the action grants `user.strike` and `image.moderate`
-- (apps/moderator/src/lib/permissions.ts). A new grant is held by nobody but moderator:admin, so copy
-- the roles that hold /users today; otherwise every moderator who could strike or remove images loses
-- the buttons at release.
--
-- HAND-APPLIED. Safe to run BEFORE the moderator release (applyGrants ignores ids not in PERMISSIONS),
-- so run it before or right after the release. Idempotent (ON CONFLICT DO NOTHING), so re-running never
-- overwrites a grant edited on /admin since.

-- Only roles the hub still defines: the /users row also carries retired names (moderator:staff,
-- moderator:senior, moderator:community-manager as of 2026-10-16), and copying them would seed grants
-- for roles nobody can hold.
INSERT INTO "AppPageAccess" ("app", "path", "roles", "updatedById", "updatedAt")
SELECT
  src."app",
  grant_key,
  ARRAY(
    SELECT role FROM unnest(src."roles") AS role
    WHERE EXISTS (SELECT 1 FROM "Role" r WHERE r."id" = role)
    ORDER BY role
  ),
  src."updatedById",
  now()
FROM "AppPageAccess" src
CROSS JOIN (VALUES ('grant:user.strike'), ('grant:image.moderate')) AS g(grant_key)
WHERE src."app" = 'moderator' AND src."path" = '/users'
ON CONFLICT ("app", "path") DO NOTHING;
