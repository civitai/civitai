-- ============================================================
-- App Store listings: per-host media — the civitai.red-only ICON and COVER override slots
-- ============================================================
-- NOT AUTO-APPLIED. Migrations in this repo are applied by hand (see CLAUDE.md -> Database):
-- there is no `prisma migrate deploy` path. A human runs this file against the main civitai
-- database (the one holding `app_listings`), dev first, then production.
--
-- REQUIRES `20261018192800_app_listing_red_media` (the table this alters). If that has not been
-- applied, this fails with `relation "app_listing_red_media" does not exist` and changes nothing.
--
-- Order relative to the code is free: apply it before or after the deploy. Every statement the
-- code issues against these columns is preceded by a probe (`listing-media-split.service.ts`)
-- of whether the table AND both columns exist, and of what the connecting role may do with the
-- table. Until this is applied every listing reads as having no civitai.red icon or cover (each
-- host shows the listing's own icon and cover, exactly as before), and setting one is refused
-- with a message saying it is not available yet.
--
-- ADDITIVE ONLY. Two new NULLable columns and their indexes on `app_listing_red_media`; no row
-- is rewritten (a NULL column with no default is a catalog-only change). Idempotent
-- (`IF NOT EXISTS`), so a re-run is a no-op.
--
-- LOCKS — brief, but one of them is on a HOT table:
--   - `ALTER TABLE` takes ACCESS EXCLUSIVE on `app_listing_red_media` (small: one row per listing
--     a moderator split, or that has a red slot). Reads and writes of it wait until COMMIT.
--   - Each `REFERENCES "Image"` takes a SHARE ROW EXCLUSIVE lock on "Image", held until COMMIT.
--     While it is held, or while this transaction is QUEUED for it, every INSERT / UPDATE /
--     DELETE on "Image" waits (reads do not). "Image" is written constantly (uploads, scans,
--     rating changes), so a long queue here is visible site-wide. The transaction itself is
--     trivial — validating the new constraints scans only `app_listing_red_media`, whose new
--     columns are all NULL — and `lock_timeout` caps each lock WAIT at 3s: if a long write
--     transaction holds "Image", this aborts instead of stalling every writer queued behind it.
--   - The two `CREATE INDEX` statements build over that same small table, inside the
--     transaction (CONCURRENTLY cannot run in one, and is not needed at this size).
-- So:
--   1. First check for long-running write transactions, e.g.
--        SELECT pid, now() - xact_start AS age, state, left(query, 80)
--          FROM pg_stat_activity
--         WHERE xact_start < now() - interval '5 seconds' AND state <> 'idle'
--         ORDER BY xact_start;
--   2. Run it off-peak.
--   3. On `canceling statement due to lock timeout`, nothing was applied (one transaction);
--      wait and re-run.
--
-- WHY THE FOREIGN KEYS (rather than plain integers cleaned up by the app): with
-- `ON DELETE SET NULL` a deleted image simply empties the slot, so the listing falls back to its
-- own icon or cover. Without it, a slot would keep pointing at a deleted image, and the go-live
-- scan gate — which treats an image it cannot find as "still scanning" — would refuse every
-- approve of that listing until someone cleared the slot by hand. The indexes keep each "Image"
-- DELETE's check of this table an index lookup, not a scan. The cost is the one-time lock above.
--
-- GRANTS — nothing new: the columns are covered by the table-level grants of the earlier
-- migration (column privileges follow table privileges). Two roles matter for these columns:
--   - the role the app WRITES with (SELECT, INSERT, UPDATE, as before): setting or clearing a
--     slot, carrying the slots onto and back from a revision, and the review reading them;
--   - the role the app's READ client connects as (SELECT): the civitai.red store pages read the
--     slots through it. Without it they show the listing's own icon and cover on civitai.red
--     too (nothing breaks); the review still shows the slots, because it reads through the
--     write client.
--
-- ROLLBACK (discards every civitai.red icon and cover; every listing then shows its own icon
-- and cover on every host, and the code does not need rolling back). Dropping the columns drops
-- their foreign keys and indexes, which takes the same locks, so run the same pre-checks:
--   BEGIN;
--   SET LOCAL lock_timeout = '3s';
--   ALTER TABLE "app_listing_red_media"
--     DROP COLUMN IF EXISTS "red_icon_id",
--     DROP COLUMN IF EXISTS "red_cover_id";
--   COMMIT;
-- A rating that a red slot raised is NOT lowered by the rollback; the next go-live or moderator
-- image re-rate floors it by the remaining media.

BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE "app_listing_red_media"
  ADD COLUMN IF NOT EXISTS "red_icon_id"  INTEGER NULL REFERENCES "Image"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "red_cover_id" INTEGER NULL REFERENCES "Image"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "app_listing_red_media_red_icon_idx"
  ON "app_listing_red_media" ("red_icon_id");
CREATE INDEX IF NOT EXISTS "app_listing_red_media_red_cover_idx"
  ON "app_listing_red_media" ("red_cover_id");

COMMIT;
