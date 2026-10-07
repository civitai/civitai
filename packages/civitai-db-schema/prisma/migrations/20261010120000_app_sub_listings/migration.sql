-- ============================================================
-- App Store SUB-LISTINGS — items a parent app places in the store as their own cards
-- ============================================================
-- NOT AUTO-APPLIED. Migrations in this repo are applied by hand (see CLAUDE.md -> Database):
-- there is no `prisma migrate deploy` path. A human runs this file against the main civitai
-- database (the one holding `app_listings`), dev first, then production, BEFORE the code that
-- reads these tables deploys. Running it before the code deploys is safe: nothing reads these
-- tables until that code is live.
--
-- If the code deploys first nothing breaks publicly: the store read path catches the missing
-- table and serves parents only, and the three `/api/v1/blocks/sub-listings/*` endpoints
-- answer 503.
--
-- ADDITIVE ONLY. Two new tables and one seed row; no column, index or row of an existing table
-- changes. Idempotent (`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`), so a re-run is a no-op.
--
-- LOCKS ON EXISTING TABLES — brief, but not zero. Each `REFERENCES` takes a SHARE ROW EXCLUSIVE
-- lock on the table it points at ("User", "Image" and "app_listings"), held until COMMIT. While it
-- is held, or while this transaction is QUEUED for it, writes (INSERT/UPDATE/DELETE) to those
-- tables wait; reads do not. The transaction itself is trivial (empty tables, one seed
-- row), and `lock_timeout` below caps each lock wait at 3s: if a long write transaction holds
-- one of those tables, this aborts instead of stalling every writer queued behind it. So:
--   1. First check for long-running write transactions on those tables, e.g.
--        SELECT pid, now() - xact_start AS age, state, left(query, 80)
--          FROM pg_stat_activity
--         WHERE xact_start < now() - interval '5 seconds' AND state <> 'idle'
--         ORDER BY xact_start;
--   2. Run it off-peak.
--   3. On `canceling statement due to lock timeout`, nothing was applied (one transaction);
--      wait and re-run.
--
-- ROLLBACK (discards every sub-listing; take a copy first if any rows matter). Dropping a table
-- also drops its foreign keys, which locks the same three referenced tables (at least against
-- writes, and depending on the Postgres version possibly against reads too) until COMMIT, so run the
-- same pre-checks:
--   BEGIN;
--   SET LOCAL lock_timeout = '3s';
--   DROP TABLE IF EXISTS "app_sub_listings";
--   DROP TABLE IF EXISTS "app_sub_listing_parents";
--   COMMIT;
-- The code tolerates the tables being absent (see above), so rolling back the schema does not
-- require rolling back the code.
--
-- The CHECK IN-lists are kept in lockstep with `APP_SUB_LISTING_STATUSES` and
-- `APP_SUB_LISTING_CONTENT_RATINGS` by
-- `src/server/services/blocks/__tests__/app-sub-listing.constants.test.ts`, which parses this
-- file. That test catches drift; it does not apply anything.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- One row per parent listing that may carry sub-listings. Rows are created by hand (this file
-- seeds the first). With no row, or enabled = false, the write endpoints refuse and the store
-- shows none of the parent's children.
CREATE TABLE IF NOT EXISTS "app_sub_listing_parents" (
  "parent_listing_id" TEXT PRIMARY KEY REFERENCES "app_listings"("id") ON DELETE CASCADE,
  "enabled"           BOOLEAN NOT NULL DEFAULT false,
  "max_per_author"    INTEGER NOT NULL DEFAULT 20 CHECK ("max_per_author" BETWEEN 1 AND 200),
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "app_sub_listings" (
  "id"                TEXT PRIMARY KEY,                    -- asl_<ULID>
  "parent_listing_id" TEXT NOT NULL REFERENCES "app_listings"("id") ON DELETE CASCADE,
  -- The app's own item key (the shared-storage row key). Idempotency key with the parent.
  "item_key"          TEXT NOT NULL CHECK (char_length("item_key") BETWEEN 1 AND 64),
  "author_user_id"    INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,

  -- LIVE columns: what the store renders.
  "title"             TEXT NOT NULL CHECK (char_length("title") BETWEEN 1 AND 80),
  "tagline"           TEXT CHECK ("tagline" IS NULL OR char_length("tagline") <= 140),
  "image_id"          INTEGER REFERENCES "Image"("id") ON DELETE SET NULL,
  -- No URL column: the link is always built server-side as /apps/run/<parent slug>/<sub_path>.
  "sub_path"          TEXT NOT NULL CHECK (
                        "sub_path" ~ '^[A-Za-z0-9_-]{1,64}(/[A-Za-z0-9_-]{1,64}){0,3}$'
                        AND char_length("sub_path") <= 128),
  "content_rating"    TEXT CHECK ("content_rating" IS NULL OR "content_rating" IN ('g','pg','pg13','r','x')),

  -- STAGED EDIT of an APPROVED row. While "pending_submitted_at" is set, the pending_* columns
  -- hold the complete proposed state (a NULL pending tagline/image/rating means "cleared") and
  -- the live columns keep serving the last approved version until a moderator approves it.
  "pending_title"          TEXT CHECK ("pending_title" IS NULL OR char_length("pending_title") BETWEEN 1 AND 80),
  "pending_tagline"        TEXT CHECK ("pending_tagline" IS NULL OR char_length("pending_tagline") <= 140),
  "pending_image_id"       INTEGER REFERENCES "Image"("id") ON DELETE SET NULL,
  "pending_sub_path"       TEXT CHECK (
                             "pending_sub_path" IS NULL
                             OR ("pending_sub_path" ~ '^[A-Za-z0-9_-]{1,64}(/[A-Za-z0-9_-]{1,64}){0,3}$'
                                 AND char_length("pending_sub_path") <= 128)),
  "pending_content_rating" TEXT CHECK ("pending_content_rating" IS NULL OR "pending_content_rating" IN ('g','pg','pg13','r','x')),
  "pending_submitted_at"   TIMESTAMPTZ(6),
  -- Set when a moderator rejects a staged edit; cleared by the next edit.
  "edit_rejection_reason"  TEXT CHECK ("edit_rejection_reason" IS NULL OR char_length("edit_rejection_reason") <= 500),

  "status"            TEXT NOT NULL DEFAULT 'pending'
                        CHECK ("status" IN ('pending','approved','hidden','withdrawn')),
  "status_reason"     TEXT CHECK ("status_reason" IS NULL OR char_length("status_reason") <= 500),
  "moderated_by_id"   INTEGER REFERENCES "User"("id") ON DELETE SET NULL,
  "moderated_at"      TIMESTAMPTZ(6),
  "approved_at"       TIMESTAMPTZ(6),
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "app_sub_listings_parent_item_key" UNIQUE ("parent_listing_id", "item_key"),
  CONSTRAINT "app_sub_listings_pending_complete" CHECK (
    "pending_submitted_at" IS NULL
    OR ("pending_title" IS NOT NULL AND "pending_sub_path" IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS "app_sub_listings_store_idx"
  ON "app_sub_listings" ("parent_listing_id", "approved_at" DESC) WHERE "status" = 'approved';
CREATE INDEX IF NOT EXISTS "app_sub_listings_queue_idx"
  ON "app_sub_listings" ("status", "created_at");
CREATE INDEX IF NOT EXISTS "app_sub_listings_pending_edit_idx"
  ON "app_sub_listings" ("pending_submitted_at") WHERE "pending_submitted_at" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "app_sub_listings_author_idx" ON "app_sub_listings" ("author_user_id");
-- FK indexes so an Image delete does not seq-scan this table.
CREATE INDEX IF NOT EXISTS "app_sub_listings_image_idx" ON "app_sub_listings" ("image_id");
CREATE INDEX IF NOT EXISTS "app_sub_listings_pending_image_idx" ON "app_sub_listings" ("pending_image_id");

-- The first parent. Matched by slug on the top-level row (never a draft revision); a missing
-- listing inserts nothing.
INSERT INTO "app_sub_listing_parents" ("parent_listing_id", "enabled")
SELECT "id", true FROM "app_listings"
 WHERE "slug" = 'custom-generators' AND "revision_of_id" IS NULL
ON CONFLICT ("parent_listing_id") DO NOTHING;

COMMIT;
