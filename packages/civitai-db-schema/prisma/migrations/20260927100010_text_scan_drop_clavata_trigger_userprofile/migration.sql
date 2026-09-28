-- Text-scan activation: stop Clavata's JobQueue enqueue for UserProfile. Apply by hand, never at release,
-- only after text-scan is 100% active for UserProfile and Clavata is disabled for it through the
-- text-scan-clavata-cutover endpoint.
-- On a lock_timeout error, re-run the file.
SET lock_timeout = '3s';
DROP TRIGGER IF EXISTS trg_moderation_userprofile ON "UserProfile";

-- Rollback (from 20250521094141_add_clavata_moderation; check it against the live definition
-- with pg_get_triggerdef before relying on it):
-- CREATE OR REPLACE TRIGGER trg_moderation_userprofile
--   AFTER UPDATE OF "bio", "message" OR INSERT
--   ON "UserProfile"
--   FOR EACH ROW
--   WHEN (NEW."bio" IS NOT NULL OR NEW."message" IS NOT NULL)
-- EXECUTE FUNCTION create_job_queue_moderation('UserProfile');
