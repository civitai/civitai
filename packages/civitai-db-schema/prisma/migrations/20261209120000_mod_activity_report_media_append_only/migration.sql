-- The "reportMedia:*" rows of ModActivity are append-only: they cannot be updated or deleted, no
-- other row can be updated into one, and the table cannot be truncated. Every other row is
-- unaffected.
--
-- No FK cascades into this table; app code never updates or deletes rows.
--
-- HAND-APPLIED. Apply as the owner of "ModActivity". One transaction: CREATE TRIGGER takes a SHARE
-- ROW EXCLUSIVE lock and DROP TRIGGER of an existing trigger an ACCESS EXCLUSIVE one, so a lock
-- timeout rolls the whole file back and leaves any earlier triggers in place. Re-run on timeout.
--
-- To revert (same locks), in one transaction:
--   DROP TRIGGER IF EXISTS "ModActivity_guard_report_media" ON "ModActivity";
--   DROP TRIGGER IF EXISTS "ModActivity_refuse_truncate" ON "ModActivity";
--   DROP FUNCTION IF EXISTS mod_activity_guard_report_media();
--   DROP FUNCTION IF EXISTS mod_activity_refuse_truncate();

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION mod_activity_guard_report_media() RETURNS trigger AS $$
BEGIN
  IF OLD."activity" LIKE 'reportMedia:%' THEN
    RAISE EXCEPTION 'ModActivity % is a reportMedia row and cannot be changed or removed', OLD."id";
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."activity" LIKE 'reportMedia:%' THEN
    RAISE EXCEPTION 'ModActivity % cannot become a reportMedia row', OLD."id";
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS "ModActivity_guard_report_media" ON "ModActivity";
CREATE TRIGGER "ModActivity_guard_report_media"
BEFORE UPDATE OR DELETE ON "ModActivity"
FOR EACH ROW EXECUTE FUNCTION mod_activity_guard_report_media();

CREATE OR REPLACE FUNCTION mod_activity_refuse_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ModActivity cannot be truncated';
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS "ModActivity_refuse_truncate" ON "ModActivity";
CREATE TRIGGER "ModActivity_refuse_truncate"
BEFORE TRUNCATE ON "ModActivity"
FOR EACH STATEMENT EXECUTE FUNCTION mod_activity_refuse_truncate();

COMMIT;
