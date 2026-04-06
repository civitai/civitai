-- Add ImageScan to JobQueueType enum
ALTER TYPE "JobQueueType" ADD VALUE 'ImageScan';

-- Create trigger function for image scan queue
-- This adds images to the queue when they need scanning:
-- 1. On INSERT with Pending status - acts as safety net if immediate scan fails
-- 2. On UPDATE when status changes to Pending/Rescan/Error - for rescans and retries
-- The job's retry delay logic prevents double-scanning of recently processed images
CREATE OR REPLACE FUNCTION image_scan_queue_trigger()
RETURNS TRIGGER AS $$
BEGIN
  -- On INSERT with Pending status (new images default to Pending)
  IF (TG_OP = 'INSERT' AND NEW.ingestion = 'Pending') THEN
    PERFORM create_job_queue_record(NEW.id, 'Image', 'ImageScan');
  END IF;

  -- On UPDATE when ingestion changes to Pending, Rescan, or Error
  IF (TG_OP = 'UPDATE' AND NEW.ingestion IN ('Pending', 'Rescan', 'Error')
      AND (OLD.ingestion IS DISTINCT FROM NEW.ingestion)) THEN
    PERFORM create_job_queue_record(NEW.id, 'Image', 'ImageScan');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create the trigger on Image table
CREATE OR REPLACE TRIGGER trg_image_scan_queue
  AFTER INSERT OR UPDATE OF ingestion ON "Image"
  FOR EACH ROW
  EXECUTE FUNCTION image_scan_queue_trigger();

-- Backfill: Split into separate queries to use the partial indexes efficiently
-- Each query targets a specific partial index

-- 1. Pending images - uses idx_image_ingestion_pending_queue (btree on id)
INSERT INTO "JobQueue" ("entityId", "entityType", "type")
SELECT id, 'Image'::"EntityType", 'ImageScan'::"JobQueueType"
FROM "Image"
WHERE ingestion = 'Pending'::"ImageIngestionStatus"
ON CONFLICT DO NOTHING;

-- 2. Rescan images - uses idx_image_ingestion_rescan_queue (btree on id)
INSERT INTO "JobQueue" ("entityId", "entityType", "type")
SELECT id, 'Image'::"EntityType", 'ImageScan'::"JobQueueType"
FROM "Image"
WHERE ingestion = 'Rescan'::"ImageIngestionStatus"
ON CONFLICT DO NOTHING;

-- 3. Error images - uses idx_image_ingestion_error_queue (btree on createdAt)
-- Only include recent errors (96 hours) to match the job's logic
INSERT INTO "JobQueue" ("entityId", "entityType", "type")
SELECT id, 'Image'::"EntityType", 'ImageScan'::"JobQueueType"
FROM "Image"
WHERE ingestion = 'Error'::"ImageIngestionStatus"
  AND "createdAt" > now() - interval '96 hours'
ON CONFLICT DO NOTHING;
