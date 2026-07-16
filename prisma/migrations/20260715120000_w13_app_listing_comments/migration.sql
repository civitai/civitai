-- ============================================================
-- App Store Listings (W13) — comments on app-listing detail pages (CommentsV2)
-- ============================================================
-- Attaches the reusable CommentsV2 system (polymorphic `Thread` + `CommentV2`) to
-- `app_listings`, exactly the way `model3d` / every other entity type is attached:
-- a new nullable-unique parent FK column on `Thread` (`appListingId`). This unlocks
-- the shared comment write/read/moderation path (lock/hide/pin/report/rate-limit)
-- for the entity type `appListing` with NO service code change — the service
-- resolves the thread by string-interpolating `${entityType}Id` → `appListingId`.
--
-- THE ONE BRIDGE: CommentsV2 is INTEGER-keyed end to end (`Thread.<parent>Id Int?
-- @unique`), but `app_listings` has a TEXT ULID PK (`apl_<ULID>`). So we cannot
-- point `Thread.appListingId` (Int) at `app_listings.id` (text). We add an INTEGER
-- surrogate `app_listings.serial_id` (UNIQUE, auto-increment, auto-backfilled for
-- existing rows) and FK `Thread.appListingId -> app_listings.serial_id`. `id` stays
-- the ULID PK. `Thread`, `CommentV2`, and `app_listings` are ALL in the SAME DB
-- (main civitai CNPG nvme0) — this is an id-TYPE bridge, NOT a cross-DB one.
--
-- ⚠️ MANUAL APPLY — per datapacket-talos CLAUDE.md DB rule #8 the main civitai CNPG
-- nvme0 DB does NOT auto-apply migrations (no `prisma migrate deploy`). This file is
-- committed for HISTORY ONLY; a HUMAN applies the SQL below per environment
-- (psql/retool). CI / deploy do NOT run it. Apply to BOTH, BEFORE the code that
-- reads/writes the new column ships to that env:
--   1. the dev clone (cnpg-cluster-dev, ns cnpg-database-dev, db civitai) — BEFORE
--      the PR preview smoke.
--   2. prod nvme0 (the live civitai DB) — BEFORE the release carrying the reader
--      (the `serial_id` in the listing-detail DTO) + writer (the comments UI).
--
-- Idempotent: IF NOT EXISTS guards on the column + index, and pg_constraint guards
-- on the two constraints, so a manual re-run is a no-op.

-- ------------------------------------------------------------
-- 1. app_listings.serial_id — the INTEGER surrogate (CommentsV2 bridge)
-- ------------------------------------------------------------
-- SERIAL matches the local convention (app_listing_reviews.id etc.). Adding a
-- SERIAL column to a populated table backfills every existing row via its DEFAULT
-- nextval() — the surrogate is assigned automatically, no manual backfill needed.
ALTER TABLE "app_listings"
  ADD COLUMN IF NOT EXISTS "serial_id" SERIAL;

-- UNIQUE *constraint* (not just an index): a Postgres FK target must be a unique
-- constraint / primary key, so `Thread.appListingId -> serial_id` needs this. The
-- constraint creates its own backing unique index; Prisma reads it as `@unique`.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_listings_serial_id_key'
  ) THEN
    ALTER TABLE "app_listings"
      ADD CONSTRAINT "app_listings_serial_id_key" UNIQUE ("serial_id");
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. Thread.appListingId — the new polymorphic parent FK (mirrors model3dId)
-- ------------------------------------------------------------
-- Same shape as every other `Thread` parent: a nullable-unique Int column + a FK
-- with ON DELETE SET NULL (deleting a listing detaches, never cascades, its thread)
-- ON UPDATE CASCADE. Matches the 20260526120000_add_3d_models `model3dId` pattern.
ALTER TABLE "Thread"
  ADD COLUMN IF NOT EXISTS "appListingId" INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS "Thread_appListingId_key"
  ON "Thread" ("appListingId");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Thread_appListingId_fkey'
  ) THEN
    ALTER TABLE "Thread"
      ADD CONSTRAINT "Thread_appListingId_fkey"
      FOREIGN KEY ("appListingId") REFERENCES "app_listings" ("serial_id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
