-- Clavata Collection retirement: stop Clavata's JobQueue enqueue for Collection. Collection has no
-- text-scan replacement. Apply by hand, never at release, only after Clavata is disabled for
-- Collection through the text-scan-clavata-cutover endpoint with a recorded sign-off.
-- On a lock_timeout error, re-run the file.
SET lock_timeout = '3s';
DROP TRIGGER IF EXISTS trg_moderation_collection ON "Collection";

-- Rollback (from 20250521094141_add_clavata_moderation; check it against the live definition
-- with pg_get_triggerdef before relying on it):
-- CREATE OR REPLACE TRIGGER trg_moderation_collection
--   AFTER UPDATE OF "name", "description" OR INSERT
--   ON "Collection"
--   FOR EACH ROW
-- EXECUTE FUNCTION create_job_queue_moderation('Collection');
