-- Durable record of which placements have reached the target's Buzz counter.
--
-- APPLY IN THIS ORDER. The order is the safety property, not a preference:
--
--   1. Steps 1-4 below, BEFORE deploying the app that reads these columns.
--   2. Deploy, and wait for the old pods to drain.
--   3. Re-run step 2 (the backfill UPDATE).
--   4. Only then turn the `placement-metric-sweep` Flipt flag ON.
--
-- Step 4 is what makes step 3 winnable. The sweep is flag-gated and default-off
-- precisely because "re-run the backfill after the deploy" cannot race a canary:
-- the old code keeps approving placements and emitting their Buzz without
-- writing these columns, so those rows look uncounted. A sweep running before
-- the backfill re-emits every one of them with a fresh timestamp — a different
-- second, so the pipeline SUMS rather than collapsing — and the counter it
-- doubles never comes back down.
--
-- The backfill's cost, stated: a placement approved by the old code whose emit
-- genuinely failed is marked counted and stays lost. That is the behaviour this
-- feature had all along, and it is indistinguishable from a successful one from
-- here.

-- 1.
ALTER TABLE "Placement" ADD COLUMN IF NOT EXISTS "metricCountedAt" TIMESTAMP(3);
ALTER TABLE "Placement" ADD COLUMN IF NOT EXISTS "metricClaimedAt" TIMESTAMP(3);
ALTER TABLE "Placement" ADD COLUMN IF NOT EXISTS "metricAttempts" INTEGER NOT NULL DEFAULT 0;

-- 2. Everything already settled was counted (or lost) by the best-effort emit
--    that shipped in #3849, and the two are indistinguishable from here.
--
--    `removed` is included, and deliberately WITHOUT the `takenDownAt` test the
--    sweep applies. The sweep must not count a placement that went straight from
--    `pending` to `removed` — a moderator clearing an abusive placer forfeits
--    that escrow, so no owner was paid and nothing was ever live. Here the same
--    rows only need to be kept out of the queue, and marking them costs nothing.
UPDATE "Placement"
SET "metricCountedAt" = COALESCE("resolvedAt", "createdAt")
WHERE status IN ('approved', 'removed')
  AND "metricCountedAt" IS NULL;

-- 3. The sweep's index. Partial on the uncounted tail, and keyed on `resolvedAt`
--    ALONE so the planner can walk it in order and stop at the LIMIT.
--
--    Leading with `status` would be worse here despite status being in the
--    predicate: the claim matches `approved OR (removed AND takenDownAt)`, and an
--    OR over the leading column gives a BitmapOr, which destroys the index order
--    and puts a sort over the whole backlog back in front of every LIMIT — at
--    exactly the moment there is a backlog worth sorting. The remaining
--    predicates are cheap filters over a set the partial clause already keeps
--    small.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Placement_resolvedAt_idx"
  ON "Placement" ("resolvedAt")
  WHERE "metricCountedAt" IS NULL;

-- 4. VERIFY, because step 3 can report success having done nothing. An
--    interrupted CONCURRENTLY build leaves the index in place marked invalid;
--    the planner ignores it while every write still maintains it, and
--    IF NOT EXISTS makes every retry a silent no-op.
--
--      SELECT indisvalid FROM pg_index
--      WHERE indexrelid = '"Placement_resolvedAt_idx"'::regclass;
--
--    On false: REINDEX INDEX CONCURRENTLY "Placement_resolvedAt_idx";
--    or DROP INDEX CONCURRENTLY and re-run step 3.
