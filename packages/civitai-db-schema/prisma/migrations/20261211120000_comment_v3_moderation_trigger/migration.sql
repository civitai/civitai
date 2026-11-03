-- CommentV3 joins the comment moderation queue, as Comment and CommentV2 did in
-- 20250521094141_add_clavata_moderation: each insert or content edit queues a ModerationRequest,
-- which Clavata scans unless the key is cut over to text scan.
--
-- `pg_trigger_depth() = 0` queues only a write made to CommentV3 directly. A row the mirror copies
-- from Comment or CommentV2 is written from inside the mirror's trigger, and that old table's own
-- moderation trigger already queued it.
--
-- Apply before the article write flip deploys; nothing writes CommentV3 directly until then.

ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'CommentV3';

CREATE OR REPLACE TRIGGER trg_moderation_commentv3
  AFTER UPDATE OF "content" OR INSERT
  ON "CommentV3"
  FOR EACH ROW
  WHEN (pg_trigger_depth() = 0)
EXECUTE FUNCTION create_job_queue_moderation('CommentV3');
