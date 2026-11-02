-- ============================================================
-- User: index for the app-data removal worklist (REQUIRED)
-- ============================================================
-- NOT AUTO-APPLIED. Migrations in this repo are applied by hand (see CLAUDE.md -> Database):
-- there is no `prisma migrate deploy` path. A human runs this file against the main civitai
-- database, dev first, then production.
--
-- REQUIRED before the job does anything. `src/server/jobs/remove-deleted-account-app-data.ts`
-- checks `pg_indexes` on the replica for this index on each run until it finds it, and does
-- nothing (logging once a day) while it is missing. It reads its worklist from the replica every
-- 10 minutes with exactly this predicate and order:
--   WHERE meta->>'appDataRemoval' = 'requested' AND "deletedAt" <= <now - 7 days>
--     AND ("deletedAt", id) after the run cursor
--   ORDER BY "deletedAt", id
-- Without the index each run would read every deleted account to find the few that carry the
-- request. The index holds only the accounts with a pending request, so it stays tiny.
--
-- ADDITIVE ONLY, idempotent. Built CONCURRENTLY: apply in autocommit (plain `psql -f`), never
-- inside a transaction block. Rollback: DROP INDEX CONCURRENTLY IF EXISTS "User_appDataRemoval_deletedAt_id_idx";

CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_appDataRemoval_deletedAt_id_idx"
  ON "User" ("deletedAt", id)
  WHERE meta->>'appDataRemoval' = 'requested';
