-- Adds the "preservedFile:*" rows of ModActivity (the preserved-file review's served, delivered and
-- verdict rows) to the append-only rules that cover the "reportMedia:*", "retractedMedia:view" and
-- "heldMedia:view" rows: they cannot be updated or deleted, no other row can be updated into one, and
-- they are stamped with the database's UTC time on insert. A verdict that could be deleted would let
-- the same file be served and ruled again.
--
-- Replaces mod_activity_guard_report_media() and the "ModActivity_stamp_db_time" trigger; the stamp
-- function and the guard triggers are unchanged.
--
-- HAND-APPLIED. Apply as the owner of "ModActivity", in one transaction, before the moderator release
-- that writes these rows.
--
-- Before applying, snapshot the triggers, to compare after:
--   SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger
--   WHERE tgrelid = '"ModActivity"'::regclass AND NOT tgisinternal ORDER BY tgname;
--
-- After applying, inside a transaction you roll back, a "preservedFile:*" row must refuse a delete
-- and get the database's time:
--   BEGIN;
--   INSERT INTO "ModActivity" ("userId", "activity", "entityType", "entityId", "createdAt")
--     VALUES (NULL, 'preservedFile:served', 'preservedFile:check', 0, '2000-01-01') RETURNING id, "createdAt";
--   -- expect createdAt = now(), not 2000-01-01
--   DELETE FROM "ModActivity" WHERE "entityType" = 'preservedFile:check';  -- expect "cannot be changed or removed"
--   ROLLBACK;
--
-- To revert, re-apply 20271118230000_mod_activity_held_media_view_append_only/migration.sql, then the
-- "ModActivity_stamp_db_time" trigger from 20271118090000_mod_activity_retracted_media_append_only.

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE TRIGGER "ModActivity_stamp_db_time"
BEFORE INSERT ON "ModActivity"
FOR EACH ROW WHEN (
  NEW."activity" LIKE 'reportMedia:%'
  OR NEW."activity" = 'heldMedia:view'
  OR NEW."activity" = 'retractedMedia:view'
  OR NEW."activity" LIKE 'preservedFile:%'
)
EXECUTE FUNCTION mod_activity_stamp_db_time();

CREATE OR REPLACE FUNCTION mod_activity_guard_report_media() RETURNS trigger AS $$
BEGIN
  IF OLD."activity" LIKE 'reportMedia:%'
    OR OLD."activity" LIKE 'preservedFile:%'
    OR OLD."activity" IN ('retractedMedia:view', 'heldMedia:view') THEN
    RAISE EXCEPTION 'ModActivity % is a % row and cannot be changed or removed', OLD."id", OLD."activity";
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW."activity" LIKE 'reportMedia:%'
    OR NEW."activity" LIKE 'preservedFile:%'
    OR NEW."activity" IN ('retractedMedia:view', 'heldMedia:view')
  ) THEN
    RAISE EXCEPTION 'ModActivity % cannot become a % row', OLD."id", NEW."activity";
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMIT;
