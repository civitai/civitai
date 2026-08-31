-- `remove-blocked-images` now counts its retention window from the JobQueue row's createdAt
-- (the moment of the block) rather than from Image.createdAt/updatedAt. That makes the queue the
-- sole record of what is pending deletion, so every path that blocks an image has to produce a
-- row. Two did not:
--   1. an INSERT that arrives already Blocked (the trigger was UPDATE-only);
--   2. a `blockedFor` repoint off 'AiNotVerified' with no ingestion change, which the
--      `AFTER UPDATE OF ingestion` clause never fired on.
-- Both leave an image blocked forever with nothing to purge it. As of writing there are ~12,689
-- such rows.

-- New function rather than CREATE OR REPLACE on blocked_image_delete_queue_trigger(): that one is
-- owned by `postgres` (the 2026-01-13 migration was applied as superuser), and replacing a function
-- requires owning it — no GRANT substitutes. This one is created by whoever applies the migration,
-- which is also the owner of "Image" and so can repoint the trigger below.
CREATE OR REPLACE FUNCTION queue_blocked_image_for_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.ingestion = 'Blocked'
      AND (NEW."blockedFor" IS NULL OR NEW."blockedFor" != 'AiNotVerified')) THEN
    -- OLD is unassigned on INSERT and touching its fields raises, so the branches stay
    -- separate: plpgsql does not guarantee short-circuit evaluation within one condition.
    IF (TG_OP = 'INSERT') THEN
      PERFORM create_job_queue_record(NEW.id, 'Image', 'BlockedImageDelete');
    -- ingestion transitioning into Blocked, or a blockedFor repoint that makes an
    -- already-Blocked row deletable for the first time.
    ELSIF (OLD.ingestion IS DISTINCT FROM NEW.ingestion
           OR OLD."blockedFor" IS DISTINCT FROM NEW."blockedFor") THEN
      PERFORM create_job_queue_record(NEW.id, 'Image', 'BlockedImageDelete');
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Replaced rather than altered: the event list widens to INSERT and to "blockedFor".
-- One transaction, because an image blocked between the DROP and the CREATE would get no
-- queue row and be retained forever — the exact bug this migration exists to close.
-- lock_timeout because CREATE TRIGGER takes ACCESS EXCLUSIVE on "Image": better to fail
-- fast behind a long transaction than to block every write to the table.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TRIGGER IF EXISTS trg_blocked_image_delete_queue ON "Image";
CREATE TRIGGER trg_blocked_image_delete_queue
  AFTER INSERT OR UPDATE OF ingestion, "blockedFor" ON "Image"
  FOR EACH ROW
  EXECUTE FUNCTION queue_blocked_image_for_delete();
COMMIT;

-- This leaves blocked_image_delete_queue_trigger() in place with nothing calling it. It can only
-- be dropped by its owner:
--   DROP FUNCTION IF EXISTS blocked_image_delete_queue_trigger();
-- Run that as `postgres` whenever convenient; skipping it is harmless.

-- Backfill the images the old trigger missed. create_job_queue_record is ON CONFLICT DO NOTHING
-- and the queue row's createdAt is the retention clock, so these get a full window from now
-- rather than being purged on the next hourly run. Deliberately the safe direction: these rows
-- have been retained indefinitely already, and a wrong clock here destroys evidence.
INSERT INTO "JobQueue" ("entityId", "entityType", "type")
SELECT i.id, 'Image'::"EntityType", 'BlockedImageDelete'::"JobQueueType"
FROM "Image" i
WHERE i.ingestion = 'Blocked'::"ImageIngestionStatus"
  AND i."blockedFor" IS DISTINCT FROM 'AiNotVerified'
ON CONFLICT DO NOTHING;
