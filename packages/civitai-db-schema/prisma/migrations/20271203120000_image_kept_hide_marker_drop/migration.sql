-- An image a kept delete hid carries the hide's marker, metadata.keptHide (deleteStatement in
-- packages/civitai-db-queries/src/content-deletion.db.ts). A release lifts the hide only while the
-- marker is still there (keptHideStands in pending-deletes.db.ts). Any later write to a block column
-- drops the marker in that same write, whichever client wrote it, so a later block (or unblock)
-- is never undone by the lift. A write that leaves the block columns out of its SET list (a post
-- reorder, a thumbnail) keeps it. The hide's own write changes the marker, so it keeps the new one.
--
-- Postgres fires an UPDATE OF trigger when a listed column is in the SET list, even if its value
-- does not change. The WHEN clause limits the function to the few rows that carry a marker.
--
-- Apply this migration before the code deploys. The code does not depend on that order: the hide
-- writes its marker only while this trigger exists and is enabled, and the lift checks it too, so a
-- row hidden without it is never lifted.
--
-- Never disable this trigger. Dropping or disabling it stops all lifts; re-enabling it after blocks
-- were written while it was off can undo them, since those blocks kept the marker.
--
-- Additive and idempotent: no data changes. Hand-applied. CREATE TRIGGER takes a brief SHARE ROW
-- EXCLUSIVE lock on "Image": apply off-peak, and retry if the lock timeout is hit.
--
-- Rollback (the lift then lifts nothing):
--   DROP TRIGGER IF EXISTS trg_image_kept_hide_drop_marker ON "Image";
--   DROP FUNCTION IF EXISTS image_kept_hide_drop_marker();

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION image_kept_hide_drop_marker() RETURNS trigger AS $$
BEGIN
  IF jsonb_typeof(NEW."metadata") = 'object'
    AND NEW."metadata" -> 'keptHide' IS NOT DISTINCT FROM OLD."metadata" -> 'keptHide' THEN
    NEW."metadata" := NEW."metadata" - 'keptHide';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_image_kept_hide_drop_marker ON "Image";
CREATE TRIGGER trg_image_kept_hide_drop_marker
  BEFORE UPDATE OF ingestion, "nsfwLevel", "blockedFor", "needsReview" ON "Image"
  FOR EACH ROW
  WHEN (OLD."metadata" ? 'keptHide')
  EXECUTE FUNCTION image_kept_hide_drop_marker();
