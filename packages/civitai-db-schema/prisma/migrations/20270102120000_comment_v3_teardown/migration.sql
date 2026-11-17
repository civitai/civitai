-- Phase 6: drop the old comment tables. Apply only after the Phase 6 deploy: the previous build still
-- reads these tables (reaction erasure, personal-data export, CSAM comment archive and context text)
-- and selects `CommentV3.removedByAuthor`.
--
-- Comments never copied to CommentV3 (Q&A and club posts) are deleted with the tables.
-- `comment_shared_id_seq` stays: CommentV3 draws its ids from it.

BEGIN;
SET LOCAL lock_timeout = '3s';

-- These take the old tables' row types, so the tables cannot be dropped while they exist.
DROP FUNCTION IF EXISTS commentv3_thread_entity("Thread");
DROP FUNCTION IF EXISTS commentv3_mirror_v1("Comment");
DROP FUNCTION IF EXISTS commentv3_mirror_v1_one("Comment");
DROP FUNCTION IF EXISTS commentv3_mirror_v2("CommentV2");
DROP FUNCTION IF EXISTS commentv3_mirror_v2_one("CommentV2");

-- No CASCADE: a view, foreign key or row-typed function outside this list fails the migration.
DROP TABLE "ThreadMute", "CommentReaction", "CommentV2Reaction", "CommentReport", "CommentV2Report",
  "Comment", "CommentV2", "Thread";

DROP FUNCTION IF EXISTS update_thread_comment_count();
DROP FUNCTION IF EXISTS update_comment_reaction_count();
DROP FUNCTION IF EXISTS commentv3_ensure_topic("CommentEntityType", integer, boolean);
DROP FUNCTION IF EXISTS commentv3_clamp_parent(integer);
DROP FUNCTION IF EXISTS commentv3_v1_id_floor();
DROP FUNCTION IF EXISTS commentv3_mirror_delete(integer);
DROP FUNCTION IF EXISTS commentv3_mirror_thread_trigger();
DROP FUNCTION IF EXISTS commentv3_mirror_thread_mute_trigger();
DROP FUNCTION IF EXISTS commentv3_mirror_v1_trigger();
DROP FUNCTION IF EXISTS commentv3_mirror_v1_reaction_trigger();
DROP FUNCTION IF EXISTS commentv3_mirror_v1_report_trigger();
DROP FUNCTION IF EXISTS commentv3_mirror_v2_trigger();
DROP FUNCTION IF EXISTS commentv3_mirror_v2_reaction_trigger();
DROP FUNCTION IF EXISTS commentv3_mirror_v2_report_trigger();

-- The orphan purge's archive (docs/comments-consolidation.md, "Orphan purge").
DROP SCHEMA IF EXISTS archive CASCADE;

DELETE FROM "KeyValue" WHERE key = 'comment-v3-parity:last';

ALTER TABLE "CommentV3" DROP COLUMN IF EXISTS "removedByAuthor";

COMMIT;
