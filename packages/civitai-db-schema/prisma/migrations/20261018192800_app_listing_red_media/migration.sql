-- ============================================================
-- App Store listings: per-host media — the moderator's MEDIA SPLIT decision
-- ============================================================
-- NOT AUTO-APPLIED. Migrations in this repo are applied by hand (see CLAUDE.md -> Database):
-- there is no `prisma migrate deploy` path. A human runs this file against the main civitai
-- database (the one holding `app_listings`), dev first, then production.
--
-- Order relative to the code is free. Every statement the code issues against this table is
-- preceded by a `to_regclass` probe (`listing-media-split.service.ts`), so while the table is
-- absent a listing simply has no split: its rating is floored by all of its media, exactly as
-- before this table existed. The one thing that fails is a moderator explicitly choosing the
-- split at approve, with a message saying it is not available yet.
--
-- ADDITIVE ONLY. One new, empty table; no column, index or row of an existing table changes.
-- Idempotent (`IF NOT EXISTS`), so a re-run is a no-op.
--
-- `red_icon_id` / `red_cover_id` are created now so the follow-up that adds civitai.red-only
-- icon and cover slots needs no second migration. Nothing reads or writes them yet.
--
-- `media_split_approved_by` is ON DELETE SET NULL, so the CHECK is one-directional (an actor
-- implies a stamp): a two-way "both or neither" CHECK would make deleting a moderator's
-- account fail on this table.
--
-- LOCKS ON EXISTING TABLES — brief, but not zero. Each `REFERENCES` takes a SHARE ROW EXCLUSIVE
-- lock on the table it points at ("app_listings", "Image" and "User"), held until COMMIT. While
-- it is held, or while this transaction is QUEUED for it, writes to those tables wait; reads do
-- not. The transaction itself is trivial (an empty table), and `lock_timeout` caps each lock
-- wait at 3s: if a long write transaction holds one of those tables, this aborts instead of
-- stalling every writer queued behind it. So:
--   1. First check for long-running write transactions, e.g.
--        SELECT pid, now() - xact_start AS age, state, left(query, 80)
--          FROM pg_stat_activity
--         WHERE xact_start < now() - interval '5 seconds' AND state <> 'idle'
--         ORDER BY xact_start;
--   2. Run it off-peak.
--   3. On `canceling statement due to lock timeout`, nothing was applied (one transaction);
--      wait and re-run.
--   4. The app's database role must be able to SELECT, INSERT and UPDATE the new table. The
--      probe only covers the table being ABSENT; a present table the app cannot read fails every
--      approve, owner republish and image re-rate. Grant it here if new tables are not
--      automatically owned by or granted to that role in this environment.
--
-- ROLLBACK (discards every split decision; every listing then reads as unsplit, and the code
-- does not need rolling back). Dropping the table drops its foreign keys, which locks the same
-- three referenced tables until COMMIT, so run the same pre-checks:
--   BEGIN;
--   SET LOCAL lock_timeout = '3s';
--   DROP TABLE IF EXISTS "app_listing_red_media";
--   COMMIT;
-- A rating that a split floored is NOT re-raised by the rollback; the next go-live or
-- moderator image re-rate floors it by all media again.

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "app_listing_red_media" (
  "app_listing_id"          TEXT        PRIMARY KEY REFERENCES "app_listings"("id") ON DELETE CASCADE,
  "red_icon_id"             INTEGER     NULL REFERENCES "Image"("id") ON DELETE SET NULL,
  "red_cover_id"            INTEGER     NULL REFERENCES "Image"("id") ON DELETE SET NULL,
  "media_split_approved_at" TIMESTAMPTZ NULL,
  "media_split_approved_by" INTEGER     NULL REFERENCES "User"("id") ON DELETE SET NULL,
  "created_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "app_listing_red_media_split_actor_chk"
    CHECK ("media_split_approved_by" IS NULL OR "media_split_approved_at" IS NOT NULL)
);

-- So an "Image" delete does not scan this table for the SET NULL. The table is new and empty,
-- so a plain CREATE INDEX is instant and may share the transaction (CONCURRENTLY cannot).
CREATE INDEX IF NOT EXISTS "app_listing_red_media_red_icon_idx"
  ON "app_listing_red_media" ("red_icon_id");
CREATE INDEX IF NOT EXISTS "app_listing_red_media_red_cover_idx"
  ON "app_listing_red_media" ("red_cover_id");

COMMIT;
