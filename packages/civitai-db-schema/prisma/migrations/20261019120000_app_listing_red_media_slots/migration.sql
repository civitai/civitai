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
--   - The order matters for the wait: ACCESS EXCLUSIVE on `app_listing_red_media` is taken
--     FIRST, so while this waits (up to 3s) for "Image", civitai.red store reads and approvals
--     that read `app_listing_red_media` wait too. civitai.com's store never reads it.
--   - SHARE ROW EXCLUSIVE also conflicts with a VACUUM of "Image": an ordinary autovacuum is
--     cancelled (and starts over later); an anti-wraparound one is not, so this would time out
--     on every attempt while it runs.
-- So:
--   1. First check for long-running write transactions, e.g.
--        SELECT pid, now() - xact_start AS age, state, left(query, 80)
--          FROM pg_stat_activity
--         WHERE xact_start < now() - interval '5 seconds' AND state <> 'idle'
--         ORDER BY xact_start;
--      and for a vacuum or any other strong lock on "Image" (ordinary writes hold
--      RowExclusiveLock, which check 1 already covers by age):
--        SELECT l.pid, l.mode, l.granted, a.backend_type, left(a.query, 80)
--          FROM pg_locks l JOIN pg_stat_activity a USING (pid)
--         WHERE l.relation = '"Image"'::regclass
--           AND l.mode NOT IN ('AccessShareLock', 'RowShareLock', 'RowExclusiveLock');
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
-- GRANTS — A REQUIRED STEP, AND IT ADDS ONE THE EARLIER MIGRATION SAID WAS NOT NEEDED
-- (corrected 2026-10-19). `20261018192800_app_listing_red_media` says the read client's role needs
-- no grant on this table; that stopped being true with these columns, which the app reads
-- through its READ client. The columns themselves need nothing beyond table-level grants (column
-- privileges follow table privileges), but BOTH roles must hold them. After applying this file,
-- unless new tables are automatically granted to these roles in this environment, run (with
-- this environment's actual role names):
--   GRANT SELECT, INSERT, UPDATE ON "app_listing_red_media" TO <app_write_role>;
--   GRANT SELECT ON "app_listing_red_media" TO <app_read_role>;
-- and check both with `has_table_privilege('<role>', 'app_listing_red_media', '<privilege>')`.
--   - <app_write_role>, the role the app's primary (write) client connects as — SELECT, INSERT,
--     UPDATE: setting or clearing a slot, carrying the slots onto a revision when it is opened
--     and back to the live listing when it is approved, the rating floors, the go-live scan
--     check, and the review modal and its preview. Every slot write is an upsert, which
--     PostgreSQL refuses without ALL THREE even when no row conflicts. Without them:
--       · no SELECT: every listing reads as having no override (as before this file); setting
--         or clearing a slot fails with a permission error;
--       · SELECT but no INSERT, or no UPDATE: setting or clearing a slot fails with a
--         permission error, so no revision can stage one; opening a revision still works (the
--         code skips carrying the overrides onto it, rather than fail the open or stage a row
--         the approve could not apply back), and approving it leaves the live overrides as they
--         are.
--   - <app_read_role>, the role the app's READ client connects as — SELECT: the civitai.red
--     store pages, both moderator queues' rows and the per-submission review page read the
--     slots through it, as does the approve's early (replica) scan check. Without it nothing
--     fails: civitai.red shows each listing's own icon and cover instead of its overrides, those
--     moderator surfaces show no override tile, and the early scan check skips the overrides
--     (the authoritative in-transaction check on the write client still covers them).
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
