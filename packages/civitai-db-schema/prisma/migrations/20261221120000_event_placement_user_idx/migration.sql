-- The showcase hat's default shows only for a player who has placed an event hat at least once,
-- ended placements included, so the batch resolver probes this per user. CONCURRENTLY, so run it on
-- its own, outside a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "EventCosmeticPlacement_userId_event_idx"
  ON "EventCosmeticPlacement" ("userId", "event");
