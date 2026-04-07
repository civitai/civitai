-- Drop the broad single-column status index — superseded by the partial index below.
DROP INDEX IF EXISTS "EntityModeration_status_idx";

-- Partial index supporting the retry-failed-text-moderation job. Only contains
-- rows the job might pick up (non-Succeeded, under retry limit), so it stays
-- tiny relative to the full table even after backfill. Ordered by
-- (status, updatedAt) so the retry query can index-seek + index-order
-- without a sort step.
CREATE INDEX "EntityModeration_retry_idx"
  ON "EntityModeration" ("status", "updatedAt")
  WHERE "status" IN ('Pending', 'Failed', 'Expired', 'Canceled')
    AND "retryCount" < 9;
