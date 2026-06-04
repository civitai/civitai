-- Add BlockedImageDelete to JobQueueType enum
ALTER TYPE "JobQueueType" ADD VALUE 'BlockedImageDelete';

-- Create trigger function for blocked image delete queue
-- This adds images to the queue when they become blocked and need to be deleted
-- The delete job will process them after the retention period (7 days)
CREATE OR REPLACE FUNCTION blocked_image_delete_queue_trigger()
RETURNS TRIGGER AS $$
BEGIN
  -- On UPDATE when ingestion changes to Blocked
  IF (TG_OP = 'UPDATE' AND NEW.ingestion = 'Blocked'
      AND (OLD.ingestion IS DISTINCT FROM NEW.ingestion)) THEN
    -- Only queue images that will actually be deleted (not AiNotVerified which is handled differently)
    IF (NEW."blockedFor" IS NULL OR NEW."blockedFor" != 'AiNotVerified') THEN
      PERFORM create_job_queue_record(NEW.id, 'Image', 'BlockedImageDelete');
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create the trigger on Image table
CREATE OR REPLACE TRIGGER trg_blocked_image_delete_queue
  AFTER UPDATE OF ingestion ON "Image"
  FOR EACH ROW
  EXECUTE FUNCTION blocked_image_delete_queue_trigger();

-- Backfill: Queue existing blocked images that are past the retention period
-- Since there's no index on Blocked status, we'll do a conditional backfill
-- that only inserts images past the 7-day cutoff to avoid queueing images
-- that shouldn't be deleted yet. This may take a while but is a one-time operation.
--
-- Note: We use ON CONFLICT DO NOTHING to handle any duplicates
INSERT INTO "JobQueue" ("entityId", "entityType", "type")
SELECT i.id, 'Image'::"EntityType", 'BlockedImageDelete'::"JobQueueType"
FROM "Image" i
WHERE i.ingestion = 'Blocked'::"ImageIngestionStatus"
  AND i."blockedFor" IS DISTINCT FROM 'AiNotVerified'
  AND (
    (i."blockedFor" = 'moderated' AND i."updatedAt" <= NOW() - INTERVAL '7 days')
    OR
    (i."blockedFor" IS DISTINCT FROM 'moderated' AND i."createdAt" <= NOW() - INTERVAL '7 days')
  )
ON CONFLICT DO NOTHING;
