-- The open hats on one entity. `findTeamRemixWaiver` asks "does this image wear the owner's event
-- hat" on every image view by a Remix Apps user (the "Remix for your team" button) and on every
-- free team submission; without this the only index with `event` first scans the event's every
-- placement.
--
-- Apply any time: the queries work without it, only slower. Run OUTSIDE a transaction (CONCURRENTLY
-- cannot run inside one). A cancelled build leaves an invalid index under this name, which IF NOT
-- EXISTS then skips: check pg_index.indisvalid after applying, and if false, DROP INDEX CONCURRENTLY
-- and run this again.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "EventCosmeticPlacement_open_entity_idx"
  ON "EventCosmeticPlacement" ("entityType", "entityId")
  WHERE "endedAt" IS NULL;
