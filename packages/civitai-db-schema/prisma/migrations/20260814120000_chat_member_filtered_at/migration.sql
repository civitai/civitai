-- Marks a membership that reached the user via Requests rather than their inbox,
-- because the sender did not satisfy the recipient's DM policy or was held by the
-- new-account filter. Null for every existing row: policy changes are not
-- retroactive, so nothing already in an inbox moves.
ALTER TABLE "ChatMember" ADD COLUMN "filteredAt" TIMESTAMP(3);

-- The rail reads Inbox/Requests by (userId, status, filteredAt); the existing
-- (userId, status, isMuted) index cannot serve the filteredAt predicate.
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction block. Run it
-- on its own, not wrapped in BEGIN/COMMIT with the ALTER above.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMember_userId_status_filteredAt_idx"
  ON "ChatMember" ("userId", "status", "filteredAt");
