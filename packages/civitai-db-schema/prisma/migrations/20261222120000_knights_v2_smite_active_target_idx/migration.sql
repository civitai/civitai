-- Apply by hand; safe before or after the deploy (the code is correct without it, only slower).
-- Every smite read filters on the active ("cleansedAt" IS NULL) smites of a target player: the per-player count
-- (smites.service.ts), the notify job's `resetPending` and the tick's reset/expiry sweeps. Without it each read scans the whole
-- table, which keeps every cleansed smite. Partial, so Prisma cannot express it and schema.full.prisma does not list it.
--
-- CONCURRENTLY cannot run inside a transaction, so run the statement on its own. A cancelled build leaves an invalid
-- index under its name, which IF NOT EXISTS then skips. After applying, check pg_index.indisvalid; if false,
-- DROP INDEX CONCURRENTLY and run it again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "NewOrderSmite_active_targetPlayerId_idx"
  ON "NewOrderSmite" ("targetPlayerId")
  WHERE "cleansedAt" IS NULL;
