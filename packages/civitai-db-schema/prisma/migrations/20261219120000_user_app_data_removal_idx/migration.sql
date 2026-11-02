-- ============================================================
-- User: index for the app-data removal worklist (OPTIONAL)
-- ============================================================
-- NOT AUTO-APPLIED. Migrations in this repo are applied by hand (see CLAUDE.md -> Database):
-- there is no `prisma migrate deploy` path. A human runs this file against the main civitai
-- database, dev first, then production.
--
-- OPTIONAL. `src/server/jobs/remove-deleted-account-app-data.ts` reads its worklist from the
-- replica every 10 minutes with exactly this predicate and order:
--   WHERE meta->>'appDataRemoval' = 'requested' AND "deletedAt" <= <now - 7 days>
--     AND ("deletedAt", id) after the run cursor
--   ORDER BY "deletedAt", id
-- The job works without the index; it then reads the deleted accounts to find the few that carry
-- the request. The index holds only the accounts with a pending request, so it stays tiny.
--
-- ADDITIVE ONLY, idempotent. Built CONCURRENTLY: apply in autocommit (plain `psql -f`), never
-- inside a transaction block. Rollback: DROP INDEX CONCURRENTLY IF EXISTS "User_appDataRemoval_deletedAt_id_idx";

CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_appDataRemoval_deletedAt_id_idx"
  ON "User" ("deletedAt", id)
  WHERE meta->>'appDataRemoval' = 'requested';
