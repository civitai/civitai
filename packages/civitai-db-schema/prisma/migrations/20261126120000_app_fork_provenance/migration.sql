-- ============================================================
-- App Blocks: forkable apps — the author opt-in and fork provenance
-- ============================================================
-- NOT AUTO-APPLIED. Migrations in this repo are applied by hand (see CLAUDE.md -> Database):
-- there is no `prisma migrate deploy` path. A human runs this file against the main civitai
-- database, dev first, then production.
--
-- ORDER RELATIVE TO THE CODE IS FREE: apply it before or after the deploy. Every new column is
-- marked no-type in `schema.full.prisma`, so the generated Prisma client never names it in a
-- default SELECT / RETURNING, and every read and write goes through raw SQL in
-- `src/server/services/blocks/app-fork.service.ts`, which treats a missing column (42703) as
-- "not available yet":
--   - reads degrade to "not forkable, not a fork";
--   - an author turning on "Let others fork this app's source" is refused with a message
--     saying the setting is not available yet;
--   - an approve carries no provenance (log-and-continue; the approve itself is unaffected).
--
-- ADDITIVE ONLY. Six nullable / defaulted columns, three foreign keys, one CHECK, three partial
-- indexes. No existing column, constraint or row changes. Idempotent (`IF NOT EXISTS` and
-- guarded `DO` blocks), so a re-run is a no-op.
--
-- `ADD COLUMN ... DEFAULT false NOT NULL` does not rewrite the table on PG 11+ (the default is
-- stored in the catalog), so every ADD COLUMN is catalog-only.
--
-- LOCKS. Each `ADD CONSTRAINT ... FOREIGN KEY` takes a SHARE ROW EXCLUSIVE lock on both tables
-- it names until COMMIT; writes to those tables wait, reads do not. The FKs are added
-- `NOT VALID` (no scan under that lock) and validated in a second statement, which takes only a
-- SHARE UPDATE EXCLUSIVE lock. Every new column is NULL on every existing row, so validation
-- has nothing to check. `lock_timeout` caps each lock wait at 3s: if a long write transaction
-- holds one of these tables, the statement aborts instead of stalling every writer queued
-- behind it.
--   1. Check for long-running write transactions first, e.g.
--        SELECT pid, now() - xact_start AS age, state, left(query, 80)
--          FROM pg_stat_activity
--         WHERE xact_start < now() - interval '5 seconds' AND state <> 'idle'
--         ORDER BY xact_start;
--   2. Run it off-peak.
--   3. On `canceling statement due to lock timeout`, nothing in that transaction was applied;
--      wait and re-run (everything is idempotent).
--
-- The three indexes are PARTIAL on `IS NOT NULL`, so on apply they are empty and build
-- instantly. Plain `CREATE INDEX` (not CONCURRENTLY) for that reason, which also keeps the
-- whole file runnable inside one transaction.
--
-- ROLLBACK (forgets every fork link and every opt-in; the code does not need rolling back — it
-- reads absent columns as "not forkable, not a fork"):
--   ALTER TABLE "app_listings" DROP COLUMN IF EXISTS "fork_of_listing_id";
--   ALTER TABLE "app_listings" DROP COLUMN IF EXISTS "forkable";
--   ALTER TABLE "app_block_publish_requests" DROP COLUMN IF EXISTS "fork_of_commit_sha";
--   ALTER TABLE "app_block_publish_requests" DROP COLUMN IF EXISTS "fork_of_app_block_id";
--   ALTER TABLE "app_blocks" DROP COLUMN IF EXISTS "fork_of_commit_sha";
--   ALTER TABLE "app_blocks" DROP COLUMN IF EXISTS "fork_of_app_block_id";
-- (Dropping a column drops its constraints and indexes with it.)

SET lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

-- The block a fork was made from, and the parent commit it started at. `fork_of_commit_sha`
-- has no FK, so it outlives the parent and keeps marking the block as a fork.
ALTER TABLE "app_blocks" ADD COLUMN IF NOT EXISTS "fork_of_app_block_id" TEXT;
ALTER TABLE "app_blocks" ADD COLUMN IF NOT EXISTS "fork_of_commit_sha" TEXT;

-- The same pair, carried onto each publish request and read on approve.
ALTER TABLE "app_block_publish_requests" ADD COLUMN IF NOT EXISTS "fork_of_app_block_id" TEXT;
ALTER TABLE "app_block_publish_requests" ADD COLUMN IF NOT EXISTS "fork_of_commit_sha" TEXT;

-- The author's opt-in, and the store listing this listing's app was forked from.
ALTER TABLE "app_listings" ADD COLUMN IF NOT EXISTS "forkable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "app_listings" ADD COLUMN IF NOT EXISTS "fork_of_listing_id" TEXT;

-- ---------------------------------------------------------------------------
-- Foreign keys (ON DELETE SET NULL: a parent's deletion never deletes or blocks a fork)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_blocks_fork_of_app_block_id_fkey') THEN
    ALTER TABLE "app_blocks"
      ADD CONSTRAINT "app_blocks_fork_of_app_block_id_fkey"
      FOREIGN KEY ("fork_of_app_block_id") REFERENCES "app_blocks"("id")
      ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_block_publish_requests_fork_of_app_block_id_fkey') THEN
    ALTER TABLE "app_block_publish_requests"
      ADD CONSTRAINT "app_block_publish_requests_fork_of_app_block_id_fkey"
      FOREIGN KEY ("fork_of_app_block_id") REFERENCES "app_blocks"("id")
      ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_listings_fork_of_listing_id_fkey') THEN
    ALTER TABLE "app_listings"
      ADD CONSTRAINT "app_listings_fork_of_listing_id_fkey"
      FOREIGN KEY ("fork_of_listing_id") REFERENCES "app_listings"("id")
      ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
  -- A listing can never be its own parent. The code refuses it too; this is the backstop.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_listings_fork_of_listing_id_not_self') THEN
    ALTER TABLE "app_listings"
      ADD CONSTRAINT "app_listings_fork_of_listing_id_not_self"
      CHECK ("fork_of_listing_id" IS NULL OR "fork_of_listing_id" <> "id") NOT VALID;
  END IF;
END $$;

ALTER TABLE "app_blocks" VALIDATE CONSTRAINT "app_blocks_fork_of_app_block_id_fkey";
ALTER TABLE "app_block_publish_requests" VALIDATE CONSTRAINT "app_block_publish_requests_fork_of_app_block_id_fkey";
ALTER TABLE "app_listings" VALIDATE CONSTRAINT "app_listings_fork_of_listing_id_fkey";
ALTER TABLE "app_listings" VALIDATE CONSTRAINT "app_listings_fork_of_listing_id_not_self";

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- "Forks of listing X" — the count and the paged list on a parent's store page. Also what the
-- ON DELETE SET NULL action scans when a parent listing is deleted (Postgres does not index a
-- FK on its own).
CREATE INDEX IF NOT EXISTS "app_listings_fork_of_listing_id_idx"
  ON "app_listings" ("fork_of_listing_id", "id")
  WHERE "fork_of_listing_id" IS NOT NULL;

-- Serve the two ON DELETE SET NULL actions when a parent block is deleted.
CREATE INDEX IF NOT EXISTS "app_blocks_fork_of_app_block_id_idx"
  ON "app_blocks" ("fork_of_app_block_id")
  WHERE "fork_of_app_block_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "app_block_publish_requests_fork_of_app_block_id_idx"
  ON "app_block_publish_requests" ("fork_of_app_block_id")
  WHERE "fork_of_app_block_id" IS NOT NULL;

RESET lock_timeout;
