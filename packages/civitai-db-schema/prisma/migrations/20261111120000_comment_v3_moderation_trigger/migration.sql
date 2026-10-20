-- Clavata moderation queue for CommentV3, matching trg_moderation_commentv2. Skip if comments have
-- already cut over to text-scan (`text-scan/clavata-cutover.ts`); the queue would fill with rows nothing
-- drains. Apply after the Phase 3 backfill, or disable the trigger while it runs: every backfilled row
-- would otherwise enqueue a moderation job.
--
-- HOW TO APPLY: an enum value is expand/contract. Deploy the client that knows 'CommentV3'
-- FIRST, then `psql -v ON_ERROR_STOP=1 -f migration.sql`. Not wrapped in a transaction: a new
-- enum label is unusable until commit, and the trigger stores it only as a literal, so the file
-- works either way.

ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'CommentV3';

CREATE OR REPLACE TRIGGER trg_moderation_commentv3
  AFTER UPDATE OF "content" OR INSERT
  ON "CommentV3"
  FOR EACH ROW
EXECUTE FUNCTION create_job_queue_moderation('CommentV3');
