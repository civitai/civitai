-- Phase 5: the old comment tables stop following CommentV3. The app no longer writes them (bar erasing a user's
-- reactions), so their rows go stale, and through the mirror (20261120120000_comment_v3_mirror) any write still
-- reaching one would reach the live comment: a delete (a cascade, the purge) deletes or tombstones it, and an
-- update copies stale values over it. Their moderation triggers would also queue scans of
-- text nobody reads. The trigger functions stay: Phase 6 drops them before the tables they take as row types.
--
-- Apply before the Phase 5 deploy: until then `syncOldRows` writes old rows with the values CommentV3
-- already holds, so dropping the mirror early costs nothing on the surfaces that write CommentV3. Applied after, the rows have gone stale first.
-- There is no rollback path after this: the reverse copy goes in the same release.

BEGIN;
SET LOCAL lock_timeout = '3s';

DROP TRIGGER IF EXISTS commentv3_mirror ON "Thread";
DROP TRIGGER IF EXISTS commentv3_mirror ON "CommentV2";
DROP TRIGGER IF EXISTS commentv3_mirror ON "Comment";
DROP TRIGGER IF EXISTS commentv3_mirror ON "CommentV2Reaction";
DROP TRIGGER IF EXISTS commentv3_mirror ON "CommentReaction";
DROP TRIGGER IF EXISTS commentv3_mirror ON "CommentV2Report";
DROP TRIGGER IF EXISTS commentv3_mirror ON "CommentReport";
DROP TRIGGER IF EXISTS commentv3_mirror ON "ThreadMute";

DROP TRIGGER IF EXISTS trg_moderation_comment ON "Comment";
DROP TRIGGER IF EXISTS trg_moderation_commentv2 ON "CommentV2";

COMMIT;
