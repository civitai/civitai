-- Main-app table ("NewOrderSmite"), so its own file: CONCURRENTLY cannot share a transaction with other DDL.
-- Apply by hand, any time; safe before or after any deploy (the code is correct without it, only slower).
-- Serves the active-smite reads ("cleansedAt" IS NULL); without it each scans the whole table, which keeps every cleansed
-- smite. Partial, so Prisma cannot express it and schema.full.prisma does not list it.
--
-- Run the statement on its own. A cancelled build leaves an invalid
-- index under its name, which IF NOT EXISTS then skips. After applying, check pg_index.indisvalid; if false,
-- DROP INDEX CONCURRENTLY and run it again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "NewOrderSmite_active_targetPlayerId_idx"
  ON "NewOrderSmite" ("targetPlayerId")
  WHERE "cleansedAt" IS NULL;
