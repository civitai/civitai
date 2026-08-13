-- The owner review queue's paging order: filter on (ownerId, surface, status),
-- order by (createdAt, id). Without it every page rescans and re-sorts all of an
-- owner's pending rows, and a refetch of a walk N pages deep pays that N+1 times.
--
-- `surface` is in the key because both queues filter on it. Left out, it cannot
-- be an index condition, and an owner with 900 pending stickers would touch all
-- 900 heap tuples to fill one 50-row page of remix submissions.
--
-- CONCURRENTLY, so it cannot run inside a transaction. Order-free with respect
-- to the deploy — nothing reads it but the planner.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Placement_ownerId_surface_status_createdAt_id_idx"
  ON "Placement" ("ownerId", "surface", "status", "createdAt", "id");

-- VERIFY, because this combination can report success having done nothing. An
-- interrupted CONCURRENTLY build leaves the index in place marked invalid; the
-- planner then ignores it while every write still maintains it, and IF NOT
-- EXISTS makes every retry a silent no-op.
--
--   SELECT indisvalid FROM pg_index
--   WHERE indexrelid = '"Placement_ownerId_surface_status_createdAt_id_idx"'::regclass;
--
-- If that returns false: REINDEX INDEX CONCURRENTLY
-- "Placement_ownerId_surface_status_createdAt_id_idx"; or DROP INDEX
-- CONCURRENTLY and re-run the statement above.
