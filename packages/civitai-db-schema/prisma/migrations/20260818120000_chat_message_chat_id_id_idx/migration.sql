-- `getInfiniteMessages` filters chatId + deletedAt, cursors on id and orders by
-- id, but ChatMessage only had (chatId, userId) and the PK — so every page read
-- the whole conversation and top-N sorted it. Measured on a 18,730-message chat:
-- 13,506 buffers per page either way. Dropping the default page from 1,000 to 50
-- multiplied that cost by 20 for anyone scrolling back.
--
-- Also serves the `latestChat` preview subquery and the post-clear existence
-- check on the send path.
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction block. Run
-- this statement on its own, not wrapped in BEGIN/COMMIT. If it fails it leaves
-- an INVALID index that must be dropped before retrying.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_chatId_id_idx"
  ON "ChatMessage" ("chatId", id) WHERE "deletedAt" IS NULL;
