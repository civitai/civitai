-- Text-scan activation: stop Clavata's JobQueue enqueue for Bounty. Apply by hand, never at release,
-- only after text-scan is 100% active for Bounty and Clavata is disabled for it through the
-- text-scan-clavata-cutover endpoint.
-- On a lock_timeout error, re-run the file.
SET lock_timeout = '3s';
DROP TRIGGER IF EXISTS trg_moderation_bounty ON "Bounty";

-- Rollback (from 20250521094141_add_clavata_moderation; check it against the live definition
-- with pg_get_triggerdef before relying on it):
-- CREATE OR REPLACE TRIGGER trg_moderation_bounty
--   AFTER UPDATE OF "name", "description" OR INSERT
--   ON "Bounty"
--   FOR EACH ROW
-- EXECUTE FUNCTION create_job_queue_moderation('Bounty');
