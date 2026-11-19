-- Adds the "heldMedia:view" rows of ModActivity to the append-only rules that cover the
-- "reportMedia:*" and "retractedMedia:view" rows: they cannot be updated or deleted, and no other row
-- can be updated into one. They are already stamped with the database's UTC time on insert
-- (20271118090000). Replaces mod_activity_guard_report_media() only; every trigger is unchanged.
--
-- HAND-APPLIED. Apply as the owner of "ModActivity", in one transaction.
--
-- Before applying, snapshot the triggers, to compare after:
--   SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger
--   WHERE tgrelid = '"ModActivity"'::regclass AND NOT tgisinternal ORDER BY tgname;
--
-- After applying, a "heldMedia:view" row must refuse a delete (inside a transaction you roll back):
--   BEGIN; DELETE FROM "ModActivity" WHERE id = (SELECT id FROM "ModActivity"
--     WHERE activity = 'heldMedia:view' LIMIT 1); ROLLBACK;  -- expect "cannot be changed or removed"
--
-- To revert, re-apply 20271118090000_mod_activity_retracted_media_append_only/migration.sql.

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION mod_activity_guard_report_media() RETURNS trigger AS $$
BEGIN
  IF OLD."activity" LIKE 'reportMedia:%'
    OR OLD."activity" IN ('retractedMedia:view', 'heldMedia:view') THEN
    RAISE EXCEPTION 'ModActivity % is a % row and cannot be changed or removed', OLD."id", OLD."activity";
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW."activity" LIKE 'reportMedia:%'
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
