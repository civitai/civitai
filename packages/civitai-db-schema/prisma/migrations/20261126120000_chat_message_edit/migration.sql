-- The text each chat message edit replaced. An edit overwrites "ChatMessage".content, so without this
-- the earlier version survives only in the ClickHouse audit log, and only while its flag is on.
--
-- APPLY BEFORE DEPLOYING the main-app build that writes it: the edit and its history row are one
-- statement, so until this table exists (and the write role may use it) every chat message edit fails.
-- The moderator app may deploy in either order; without the table its transcript falls back to the
-- ClickHouse log and says the history may be incomplete.
--
-- ADDITIVE ONLY. One new, empty table; nothing existing changes. Idempotent (`IF NOT EXISTS`).
--
-- Cascades with the message, so a hard delete of the message (account deletion) removes its history.
-- A soft delete ("deletedAt") keeps both.
--
-- LOCKS: the `REFERENCES` takes a SHARE ROW EXCLUSIVE lock on "ChatMessage" until COMMIT, so chat
-- sends and edits wait while it is held or queued. `lock_timeout` caps the wait at 3s:
--   1. First check for long-running write transactions, e.g.
--        SELECT pid, now() - xact_start AS age, state, left(query, 80)
--          FROM pg_stat_activity
--         WHERE xact_start < now() - interval '5 seconds' AND state <> 'idle'
--         ORDER BY xact_start;
--   2. Run it off-peak.
--   3. On `canceling statement due to lock timeout`, nothing was applied; wait and re-run.
--
-- GRANTS: if new tables are not automatically granted in this environment, grant
--   - the main app's write role: SELECT, INSERT on "ChatMessageEdit" and USAGE on
--     "ChatMessageEdit_id_seq". Without them every chat message edit fails.
--   - the moderator app's read role: SELECT on "ChatMessageEdit". Without it the transcript reads
--     the ClickHouse log alone and marks the history incomplete.
--
-- ROLLBACK (discards the recorded history; deploy the previous main-app build first, or edits fail):
--   BEGIN;
--   SET LOCAL lock_timeout = '3s';
--   DROP TABLE IF EXISTS "ChatMessageEdit";
--   COMMIT;

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "ChatMessageEdit" (
  "id" SERIAL PRIMARY KEY,
  "messageId" INTEGER NOT NULL REFERENCES "ChatMessage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "editorId" INTEGER NOT NULL,
  "previousContent" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "ChatMessageEdit_messageId_id_idx" ON "ChatMessageEdit" ("messageId", "id");

COMMIT;
