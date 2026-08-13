-- The owner review queue's paging order: filter on (ownerId, status), order by
-- (createdAt, id). Without it every page rescans and re-sorts all of an owner's
-- pending rows, and a refetch of a walk N pages deep pays that N+1 times.
--
-- CONCURRENTLY, so it cannot run inside a transaction. Safe to apply before or
-- after the deploy — nothing reads it but the planner.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Placement_ownerId_status_createdAt_id_idx"
  ON "Placement" ("ownerId", "status", "createdAt", "id");
