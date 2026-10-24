-- Apply by hand, BEFORE the deploy that ships this column: Prisma selects every scalar column on
-- any crucible query without an explicit `select`, so new code against an old table errors.
-- Old code ignores the column, so applying it early is safe.
--
-- A constant default makes the ADD COLUMN a metadata-only change; it does not rewrite the table.
ALTER TABLE "Crucible" ADD COLUMN IF NOT EXISTS "eventTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- CONCURRENTLY cannot run inside a transaction, so run this statement on its own. A cancelled build
-- leaves an invalid index under this name, which IF NOT EXISTS then skips. After applying, check
-- pg_index.indisvalid; if false, DROP INDEX CONCURRENTLY and run this again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Crucible_eventTags_idx" ON "Crucible" USING GIN ("eventTags");
