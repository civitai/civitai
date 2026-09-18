-- The attach sweep runs every cron tick and orders by "completedAt", which no index covers: without
-- this it heap-reads every Completed row, filters, sorts, and only then takes its one row — on the
-- primary, and in the steady state to find nothing. `Completed` is terminal and nothing prunes it,
-- so the scanned set only grows.
--
-- The predicate matches the query's WHERE term for term, which is what lets the planner use it. A
-- failed attach records `error`, so a poisoned row drops straight out of the index and it stays
-- near-empty rather than tracking the table.
--
-- CONCURRENTLY cannot run inside a transaction block — run this statement on its own.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "HuggingFaceImport_pending_attach_idx"
  ON "HuggingFaceImport" ("completedAt")
  WHERE status = 'Completed'
    AND "modelFileId" IS NULL
    AND "attachVersionId" IS NOT NULL
    AND error IS NULL;
