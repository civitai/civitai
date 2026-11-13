-- One-off data migration, applied by hand AFTER the moderator app with the Prompts page is deployed.
-- Merges the roles granted on the retired /text-scan/check and /text-scan/playground pages into
-- /text-scan/prompts, then removes the retired rows. Safe to re-run.
BEGIN;

WITH merged AS (
  SELECT ARRAY(
    SELECT DISTINCT role
    FROM "AppPageAccess" a, unnest(a.roles) AS role
    WHERE a.app = 'moderator'
      AND a.path IN ('/text-scan/prompts', '/text-scan/check', '/text-scan/playground')
    ORDER BY role
  ) AS roles
)
INSERT INTO "AppPageAccess" (app, path, roles, "updatedAt")
SELECT 'moderator', '/text-scan/prompts', roles, now()
FROM merged
WHERE cardinality(roles) > 0
ON CONFLICT (app, path) DO UPDATE SET roles = EXCLUDED.roles, "updatedAt" = EXCLUDED."updatedAt";

DELETE FROM "AppPageAccess"
WHERE app = 'moderator' AND path IN ('/text-scan/check', '/text-scan/playground');

COMMIT;
