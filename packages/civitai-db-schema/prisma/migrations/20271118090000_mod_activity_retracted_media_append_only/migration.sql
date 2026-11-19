-- Adds the "retractedMedia:view" rows of ModActivity to the append-only rules that already cover the
-- "reportMedia:*" rows: they cannot be updated or deleted, no other row can be updated into one, and
-- they are stamped with the database's UTC time as they are inserted, whatever "createdAt" the
-- insert names. Replaces mod_activity_guard_report_media() and the "ModActivity_stamp_db_time"
-- trigger from 20261209120000_mod_activity_report_media_append_only; the stamp function and the
-- guard and truncate triggers are unchanged.
--
-- HAND-APPLIED. Apply as the owner of "ModActivity". One transaction: CREATE OR REPLACE TRIGGER
-- takes a SHARE ROW EXCLUSIVE lock, so a lock timeout rolls the whole file back and leaves the
-- earlier definitions in place. Re-run on timeout.
--
-- To revert, re-apply 20261209120000_mod_activity_report_media_append_only/migration.sql.

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE TRIGGER "ModActivity_stamp_db_time"
BEFORE INSERT ON "ModActivity"
FOR EACH ROW WHEN (
  NEW."activity" LIKE 'reportMedia:%'
  OR NEW."activity" = 'heldMedia:view'
  OR NEW."activity" = 'retractedMedia:view'
)
EXECUTE FUNCTION mod_activity_stamp_db_time();

CREATE OR REPLACE FUNCTION mod_activity_guard_report_media() RETURNS trigger AS $$
BEGIN
  IF OLD."activity" LIKE 'reportMedia:%' OR OLD."activity" = 'retractedMedia:view' THEN
    RAISE EXCEPTION 'ModActivity % is a % row and cannot be changed or removed', OLD."id", OLD."activity";
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."activity" LIKE 'reportMedia:%' OR NEW."activity" = 'retractedMedia:view') THEN
    RAISE EXCEPTION 'ModActivity % cannot become a % row', OLD."id", NEW."activity";
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMIT;
