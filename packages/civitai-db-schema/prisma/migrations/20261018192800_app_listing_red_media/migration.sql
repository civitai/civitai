-- ============================================================
-- App Store listings: per-host media — the moderator's MEDIA SPLIT decision
-- ============================================================
-- NOT AUTO-APPLIED. Migrations in this repo are applied by hand (see CLAUDE.md -> Database):
-- there is no `prisma migrate deploy` path. A human runs this file against the main civitai
-- database (the one holding `app_listings`), dev first, then production.
--
-- Order relative to the code is free: apply it before or after the deploy. Every statement the
-- code issues against this table is preceded by a probe (`listing-media-split.service.ts`) of
-- whether the table exists AND what the connecting role may do with it, so until it is applied
-- every listing reads unsplit: its rating is floored by all of its media, exactly as before this
-- table existed. The one thing that fails is a moderator explicitly choosing the split at
-- approve, which is refused with a message saying it is not available yet.
--
-- ADDITIVE ONLY. One new, empty table; no column, index or row of an existing table changes.
-- Idempotent (`IF NOT EXISTS`), so a re-run is a no-op.
--
-- `media_split_approved_by` is ON DELETE SET NULL, so the CHECK is one-directional (an actor
-- implies a stamp): a two-way "both or neither" CHECK would make deleting a moderator's
-- account fail on this table.
--
-- LOCKS ON EXISTING TABLES — brief, but not zero. Each `REFERENCES` takes a SHARE ROW EXCLUSIVE
-- lock on the table it points at ("app_listings" and "User"), held until COMMIT. While
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
--   4. GRANTS — two roles, if new tables are not automatically owned by or granted to them in
--      this environment:
--        - the role the app WRITES with (its primary client): SELECT, INSERT, UPDATE;
--        - the role the app's READ client connects as: SELECT.
--      Missing grants are fail-safe but not silent. A role that cannot SELECT the table reads
--      every listing as unsplit (as if the table were absent), so author and store reads keep
--      working — but without the READ client's grant the review modal shows a split listing as
--      unsplit and preselects ending the split. A go-live that would write it — a split, or clearing one, which every approve
--      without a split decision does — is refused up front with a moderator-facing message when
--      the writing role lacks the privileges it needs, and nothing is written or built: a split
--      needs all three; a clear needs SELECT, plus UPDATE when the listing is split. So with the
--      table present and NO grant to the write role, every listing go-live approve is refused
--      until it is granted.
--
-- ROLLBACK (discards every split decision; every listing then reads as unsplit, and the code
-- does not need rolling back). Dropping the table drops its foreign keys, which locks the same
-- two referenced tables until COMMIT, so run the same pre-checks:
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
  "media_split_approved_at" TIMESTAMPTZ NULL,
  "media_split_approved_by" INTEGER     NULL REFERENCES "User"("id") ON DELETE SET NULL,
  "created_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "app_listing_red_media_split_actor_chk"
    CHECK ("media_split_approved_by" IS NULL OR "media_split_approved_at" IS NOT NULL)
);

COMMIT;
