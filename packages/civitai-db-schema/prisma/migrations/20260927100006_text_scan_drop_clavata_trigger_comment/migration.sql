-- Text-scan activation: stop Clavata's JobQueue enqueue for Comment. Apply by hand, never at release,
-- only after text-scan is 100% active for Comment and Clavata is disabled for it through the
-- text-scan-clavata-cutover endpoint.
-- On a lock_timeout error, re-run the file.
SET lock_timeout = '3s';
DROP TRIGGER IF EXISTS trg_moderation_comment ON "Comment";

-- Rollback (from 20250521094141_add_clavata_moderation; check it against the live definition
-- with pg_get_triggerdef before relying on it):
-- CREATE OR REPLACE TRIGGER trg_moderation_comment
--   AFTER UPDATE OF "content" OR INSERT
--   ON "Comment"
--   FOR EACH ROW
-- EXECUTE FUNCTION create_job_queue_moderation('Comment');
