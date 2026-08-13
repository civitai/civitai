-- Durable record of which placements have reached the target's Buzz counter.
--
-- Apply in this order:
--   1. Steps 1-3 below, BEFORE deploying the app that reads the column.
--   2. Deploy.
--   3. Re-run step 2 ONCE after the deploy reports healthy.
--
-- Step 3 is not optional and not a no-op. Between step 1 and the deploy, the old
-- code keeps approving placements and emitting their Buzz without writing the
-- column, so those rows land in the sweep's queue already counted and would be
-- counted a second time on the first tick. Re-running the backfill closes that
-- window. Its cost is the same loss this feature had all along: a placement
-- approved in that window whose emit failed stays uncounted.

-- 1.
ALTER TABLE "Placement" ADD COLUMN IF NOT EXISTS "metricCountedAt" TIMESTAMP(3);

-- 2. Everything already settled was counted (or lost) by the best-effort emit
--    that shipped in #3849, and the two are indistinguishable from here. Marking
--    them counted keeps the sweep off history it cannot judge.
--
--    `removed` is included because those placements were approved first — the
--    counter counts the approval and never reverses, so a later takedown does
--    not put them back in the queue.
UPDATE "Placement"
SET "metricCountedAt" = COALESCE("resolvedAt", "createdAt")
WHERE status IN ('approved', 'removed')
  AND "metricCountedAt" IS NULL;

-- 3. The sweep's index. CONCURRENTLY, so it cannot be wrapped in a transaction
--    with the statements above.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Placement_status_metricCountedAt_idx"
  ON "Placement" ("status", "metricCountedAt");
