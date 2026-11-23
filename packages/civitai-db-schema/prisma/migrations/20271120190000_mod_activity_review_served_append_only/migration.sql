-- Adds the "review-media-served" rows of ModActivity (a general-tier review batch's view log) to the
-- append-only rules that cover the "reportMedia:*", "preservedFile:*", "retractedMedia:view" and
-- "heldMedia:view" rows: they cannot be updated or deleted, no other row can be updated into one, and
-- they are stamped with the database's UTC time on insert.
--
-- Replaces mod_activity_guard_report_media() and the "ModActivity_stamp_db_time" trigger; the stamp
-- function and the guard triggers are unchanged.
--
-- HAND-APPLIED. Apply as the owner of "ModActivity", in one transaction.
--
-- Before applying, snapshot the triggers, to compare after:
--   SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger
--   WHERE tgrelid = '"ModActivity"'::regclass AND NOT tgisinternal ORDER BY tgname;
--
-- After applying, inside a transaction you roll back, a "review-media-served" row must refuse a
-- delete and get the database's time:
--   BEGIN;
--   INSERT INTO "ModActivity" ("userId", "activity", "entityType", "entityId", "createdAt")
--     VALUES (NULL, 'review-media-served', 'reviewServed:check', 0, '2000-01-01') RETURNING id, "createdAt";
--   -- expect createdAt = now(), not 2000-01-01
--   DELETE FROM "ModActivity" WHERE "entityType" = 'reviewServed:check';  -- expect "cannot be changed or removed"
--   ROLLBACK;
--
-- To revert, re-apply 20271120090000_mod_activity_preserved_file_append_only/migration.sql.

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE TRIGGER "ModActivity_stamp_db_time"
BEFORE INSERT ON "ModActivity"
FOR EACH ROW WHEN (
  NEW."activity" LIKE 'reportMedia:%'
  OR NEW."activity" = 'heldMedia:view'
  OR NEW."activity" = 'retractedMedia:view'
  OR NEW."activity" = 'review-media-served'
  OR NEW."activity" LIKE 'preservedFile:%'
)
EXECUTE FUNCTION mod_activity_stamp_db_time();

CREATE OR REPLACE FUNCTION mod_activity_guard_report_media() RETURNS trigger AS $$
BEGIN
  IF OLD."activity" LIKE 'reportMedia:%'
    OR OLD."activity" LIKE 'preservedFile:%'
    OR OLD."activity" IN ('retractedMedia:view', 'heldMedia:view', 'review-media-served') THEN
    RAISE EXCEPTION 'ModActivity % is a % row and cannot be changed or removed', OLD."id", OLD."activity";
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW."activity" LIKE 'reportMedia:%'
    OR NEW."activity" LIKE 'preservedFile:%'
    OR NEW."activity" IN ('retractedMedia:view', 'heldMedia:view', 'review-media-served')
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
