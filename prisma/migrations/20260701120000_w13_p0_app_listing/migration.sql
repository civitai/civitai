-- ============================================================
-- App Store Listings (W13) — P0 data model
-- ============================================================
-- Introduces the store-facing AppListing entity + its children (screenshots,
-- reviews, metric rollup, publish requests). AppListing fronts BOTH on-site App
-- Blocks (app_blocks, iframe/page apps we host) and off-site apps (external-link
-- or OAuth-connect) in one /apps store — see
-- claudedocs/app-blocks-app-store-listings-plan-2026-07-01.md.
--
-- P0 = data model + backfill ONLY, fully DARK: NO UI, NO read-path change. These
-- tables are additive and read by nothing in the running image, so applying them
-- ahead of / independent of the code deploy is inert. Assets (icon/cover/
-- screenshots) are NULLABLE here; the mandatory-asset approve-gate is P1.
--
-- ⚠️ MANUAL APPLY — per datapacket-talos CLAUDE.md DB rule #8 the main civitai
-- CNPG nvme0 DB does NOT auto-apply migrations (no prisma migrate deploy).
-- This file is committed for HISTORY ONLY; a HUMAN applies the SQL below per
-- environment (psql/retool). CI / deploy do NOT run it. Apply to BOTH:
--   1. prod nvme0   (the live civitai DB)
--   2. the dev clone (cnpg-cluster-dev, ns cnpg-database-dev, db civitai)
--
-- Idempotent: IF NOT EXISTS guards on every table/index so a manual re-run is a
-- no-op (Prisma's own DDL is not idempotent; this is hand-applied). All indexes
-- are created on brand-new EMPTY tables, so plain CREATE INDEX takes no
-- meaningful lock — CONCURRENTLY is unnecessary here (and cannot run in a txn).
-- String enums use CHECK constraints (mirrors the app_blocks.status pattern).

-- ------------------------------------------------------------
-- app_listings — the store-facing record, decoupled from runtime
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "app_listings" (
  "id"                TEXT PRIMARY KEY,                       -- apl_<ULID>
  -- Store kind discriminator.
  "kind"              TEXT NOT NULL,
  -- Globally-unique store slug across BOTH kinds. On-site = AppBlock.block_id.
  "slug"              TEXT NOT NULL,
  "name"              TEXT NOT NULL,
  "tagline"           TEXT,
  "description"       TEXT,
  -- Assets via the standard Image path. NULLABLE in P0 (mandatory gate is P1).
  -- SET NULL on image delete so a listing survives asset GC.
  "icon_id"           INTEGER REFERENCES "Image"("id") ON DELETE SET NULL,
  "cover_id"          INTEGER REFERENCES "Image"("id") ON DELETE SET NULL,
  -- Free-text marketplace category (taxonomy = MARKETPLACE_CATEGORIES const).
  "category"          TEXT,
  "status"            TEXT NOT NULL DEFAULT 'draft',
  -- Maturity rating. On-site MIRRORS app_blocks.content_rating (single source);
  -- off-site carries its own. Same domain as app_blocks (g..x). Nullable in P0.
  "content_rating"    TEXT,
  -- Off-site external-link target (Visit CTA). NULL for on-site / OAuth-connect.
  "external_url"      TEXT,
  -- Off-site OAuth-connect client (Connect CTA). SET NULL keeps the listing if
  -- the client row is deleted.
  "connect_client_id" TEXT REFERENCES "OauthClient"("id") ON DELETE SET NULL,
  -- 1:1 backing app_blocks row (UNIQUE below). Set for EVERY backfilled row —
  -- on-site AND the #2821 off-site rows (both originate from app_blocks); it is
  -- the idempotency key, NOT a kind discriminator. Readers MUST use "kind", never
  -- app_block_id nullness. Only a natively-created off-site listing leaves it NULL.
  "app_block_id"      TEXT REFERENCES "app_blocks"("id") ON DELETE SET NULL,
  "featured"          BOOLEAN NOT NULL DEFAULT false,
  "featured_order"    INTEGER,
  -- Listing owner (the developer). CASCADE on GDPR user-delete.
  "user_id"           INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "app_listings_kind_check"
    CHECK ("kind" IN ('onsite', 'offsite')),
  CONSTRAINT "app_listings_status_check"
    CHECK ("status" IN ('draft', 'pending', 'approved', 'rejected')),
  CONSTRAINT "app_listings_content_rating_check"
    CHECK ("content_rating" IS NULL OR "content_rating" IN ('g', 'pg', 'pg13', 'r', 'x'))
);

-- Global slug uniqueness (across both kinds). Prisma-default name for @unique.
CREATE UNIQUE INDEX IF NOT EXISTS "app_listings_slug_key"
  ON "app_listings" ("slug");
-- 1:1 on-site binding. Prisma-default name for @unique.
CREATE UNIQUE INDEX IF NOT EXISTS "app_listings_app_block_id_key"
  ON "app_listings" ("app_block_id");
-- Marketplace read-path indexes (future P2 read path).
CREATE INDEX IF NOT EXISTS "app_listings_status_kind_idx"
  ON "app_listings" ("status", "kind");
CREATE INDEX IF NOT EXISTS "app_listings_featured_order_idx"
  ON "app_listings" ("featured", "featured_order");
CREATE INDEX IF NOT EXISTS "app_listings_category_idx"
  ON "app_listings" ("category");
CREATE INDEX IF NOT EXISTS "app_listings_user_idx"
  ON "app_listings" ("user_id");

-- ------------------------------------------------------------
-- app_listing_screenshots — ordered + captioned rows (NOT a Json blob)
-- ------------------------------------------------------------
-- Table CREATED in P0; POPULATED in P1 (the asset pipeline). image_id NULLABLE.
CREATE TABLE IF NOT EXISTS "app_listing_screenshots" (
  "id"              TEXT PRIMARY KEY,                          -- apls_<ULID>
  "app_listing_id"  TEXT NOT NULL REFERENCES "app_listings"("id") ON DELETE CASCADE,
  "image_id"        INTEGER REFERENCES "Image"("id") ON DELETE SET NULL,
  "order"           INTEGER NOT NULL DEFAULT 0,
  "caption"         TEXT,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "app_listing_screenshots_order_idx"
  ON "app_listing_screenshots" ("app_listing_id", "order");

-- ------------------------------------------------------------
-- app_listing_reviews — Steam-style "recommend", listing-keyed
-- ------------------------------------------------------------
-- Shaped like ResourceReview core columns. P4 migrates AppBlockReview rows here
-- via the already-present "recommended" column. The reactions/reports CHILD
-- tables ResourceReview has are P4 — NOT created here.
CREATE TABLE IF NOT EXISTS "app_listing_reviews" (
  "id"              SERIAL PRIMARY KEY,
  "app_listing_id"  TEXT NOT NULL REFERENCES "app_listings"("id") ON DELETE CASCADE,
  "user_id"         INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "recommended"     BOOLEAN NOT NULL,
  "details"         TEXT,
  -- Moderator controls: keep abusive reviews out of the recommend-% aggregate.
  "exclude"         BOOLEAN NOT NULL DEFAULT false,
  "tos_violation"   BOOLEAN NOT NULL DEFAULT false,
  "metadata"        JSONB,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One review per (user, listing).
CREATE UNIQUE INDEX IF NOT EXISTS "app_listing_reviews_listing_user_uniq"
  ON "app_listing_reviews" ("app_listing_id", "user_id");
-- Aggregate read path: COUNT recommended WHERE NOT exclude, per listing.
CREATE INDEX IF NOT EXISTS "app_listing_reviews_listing_agg_idx"
  ON "app_listing_reviews" ("app_listing_id", "exclude");

-- ------------------------------------------------------------
-- app_listing_metrics — job-populated rollup (mirror ModelMetric)
-- ------------------------------------------------------------
-- Table only in P0; the population job is P5. Per-kind counter mapping (P5):
-- on-site = install/open/tip; off-site = connect/visit/tip.
CREATE TABLE IF NOT EXISTS "app_listing_metrics" (
  "app_listing_id"       TEXT PRIMARY KEY REFERENCES "app_listings"("id") ON DELETE CASCADE,
  "thumbs_up_count"      INTEGER NOT NULL DEFAULT 0,
  "thumbs_down_count"    INTEGER NOT NULL DEFAULT 0,
  "install_count"        INTEGER NOT NULL DEFAULT 0,
  "open_count"           INTEGER NOT NULL DEFAULT 0,
  "connect_count"        INTEGER NOT NULL DEFAULT 0,
  "visit_count"          INTEGER NOT NULL DEFAULT 0,
  "tipped_count"         INTEGER NOT NULL DEFAULT 0,
  "tipped_amount_count"  INTEGER NOT NULL DEFAULT 0,
  "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- app_listing_publish_requests — off-site submission + unified queue (P3)
-- ------------------------------------------------------------
-- Sibling to app_block_publish_requests; lighter (no bundle/forgejo/deploy).
-- STRUCTURE ONLY in P0; wired in P3.
CREATE TABLE IF NOT EXISTS "app_listing_publish_requests" (
  "id"                    TEXT PRIMARY KEY,                    -- alpr_<ULID>
  "app_listing_id"        TEXT REFERENCES "app_listings"("id") ON DELETE SET NULL,
  "kind"                  TEXT NOT NULL,
  "slug"                  TEXT NOT NULL,
  "submitted_by_user_id"  INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "submitted_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "status"                TEXT NOT NULL,
  "reviewed_by_user_id"   INTEGER REFERENCES "User"("id") ON DELETE SET NULL,
  "reviewed_at"           TIMESTAMPTZ,
  "rejection_reason"      TEXT,
  "approval_notes"        TEXT,
  "changelog"             TEXT,
  "created_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "app_listing_publish_requests_kind_check"
    CHECK ("kind" IN ('onsite', 'offsite')),
  CONSTRAINT "app_listing_publish_requests_status_check"
    CHECK ("status" IN ('pending', 'approved', 'rejected', 'withdrawn'))
);

CREATE INDEX IF NOT EXISTS "app_listing_publish_requests_queue_idx"
  ON "app_listing_publish_requests" ("status", "submitted_at" DESC);
CREATE INDEX IF NOT EXISTS "app_listing_publish_requests_listing_history_idx"
  ON "app_listing_publish_requests" ("app_listing_id", "submitted_at" DESC);
CREATE INDEX IF NOT EXISTS "app_listing_publish_requests_my_submissions_idx"
  ON "app_listing_publish_requests" ("submitted_by_user_id", "status");
CREATE INDEX IF NOT EXISTS "app_listing_publish_requests_slug_idx"
  ON "app_listing_publish_requests" ("slug", "status");
