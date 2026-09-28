-- Text-scan activation: stop Clavata's JobQueue enqueue for User. Apply by hand, never at release,
-- only after text-scan is 100% active for User and Clavata is disabled for it through the
-- text-scan-clavata-cutover endpoint.
-- On a lock_timeout error, re-run the file.
SET lock_timeout = '3s';
DROP TRIGGER IF EXISTS trg_moderation_user ON "User";

-- Rollback (from 20250521094141_add_clavata_moderation; check it against the live definition
-- with pg_get_triggerdef before relying on it):
-- CREATE OR REPLACE TRIGGER trg_moderation_user
--   AFTER UPDATE OF "username" OR INSERT
--   ON "User"
--   FOR EACH ROW
-- EXECUTE FUNCTION create_job_queue_moderation('User');
