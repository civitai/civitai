-- ============================================================
-- App Store Listings (W13) — P3b off-site moderation: app_listing_reports
-- ============================================================
-- User-facing report affordance for an approved off-site AppListing (feeds the
-- mod queue that arbitrates a delist / claim). Dedicated table, NOT the shared
-- site Report hub — keeps the off-site path isolated (no shared-moderation blast
-- radius). See claudedocs/app-blocks-p3b-delist-claim-scope-2026-07-06.md.
--
-- DARK/INERT: no code reads or writes this table until P3b PR2 ships, so applying
-- it ahead of / independent of the code deploy is a no-op (like the P0 tables).
--
-- ⚠️ MANUAL APPLY — per datapacket-talos CLAUDE.md DB rule #8 the main civitai
-- CNPG nvme0 DB does NOT auto-apply migrations (no prisma migrate deploy). This
-- file is committed for HISTORY ONLY; a HUMAN applies the SQL below per
-- environment (psql/retool). CI / deploy do NOT run it. Apply to BOTH:
--   1. prod nvme0   (the live civitai DB)
--   2. the dev clone (cnpg-cluster-dev, ns cnpg-database-dev, db civitai)
--
-- Idempotent: IF NOT EXISTS guards so a manual re-run is a no-op. All indexes
-- are created on a brand-new EMPTY table, so plain CREATE INDEX takes no
-- meaningful lock (CONCURRENTLY is unnecessary and cannot run in a txn). String
-- enums use CHECK constraints (mirrors the app_listings.status pattern).

CREATE TABLE IF NOT EXISTS "app_listing_reports" (
  "id"                 TEXT PRIMARY KEY,                        -- alrp_<ULID>
  "app_listing_id"     TEXT NOT NULL REFERENCES "app_listings"("id") ON DELETE CASCADE,
  -- The reporter. CASCADE on GDPR user-delete.
  "reporter_user_id"   INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "reason"             TEXT NOT NULL,
  "details"            TEXT,
  "status"             TEXT NOT NULL DEFAULT 'pending',
  -- The moderator who resolved/dismissed it. SET NULL preserves the row on
  -- moderator user-delete.
  "resolved_by_user_id" INTEGER REFERENCES "User"("id") ON DELETE SET NULL,
  "resolved_at"        TIMESTAMPTZ,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "app_listing_reports_reason_check"
    CHECK ("reason" IN ('impersonation', 'phishing-malware', 'broken', 'inappropriate', 'spam', 'other')),
  CONSTRAINT "app_listing_reports_status_check"
    CHECK ("status" IN ('pending', 'resolved', 'dismissed'))
);

-- FIFO mod queue (open reports first).
CREATE INDEX IF NOT EXISTS "app_listing_reports_queue_idx"
  ON "app_listing_reports" ("status", "created_at" DESC);
-- Per-listing history.
CREATE INDEX IF NOT EXISTS "app_listing_reports_listing_idx"
  ON "app_listing_reports" ("app_listing_id");
-- Anti-spam dedup: ONE open report per reporter per listing. Partial-unique is
-- NOT expressible in Prisma (the schema carries only a plain composite @@index
-- named app_listing_reports_dedup_idx); the real constraint lives HERE. A
-- P2002 on this index → friendly "you already reported this listing" (dedup at
-- the DB layer, not just app-layer). Mirrors the on-site one-pending-per-slug
-- partial-unique pattern (20260630130000_app_block_one_pending_per_slug_idempotent).
CREATE UNIQUE INDEX IF NOT EXISTS "app_listing_reports_one_open_per_reporter"
  ON "app_listing_reports" ("app_listing_id", "reporter_user_id")
  WHERE "status" = 'pending';
