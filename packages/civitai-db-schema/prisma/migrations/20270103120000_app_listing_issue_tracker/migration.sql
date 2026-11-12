-- App Store listings: an optional public ISSUE-TRACKER / SUPPORT link, shown as a `Support` row
-- on the store detail page. On-site listings take it from the manifest's `bugs` key on approve;
-- off-site listings from the listing form. Any https host, normalised by
-- `validateIssueTrackerUrl` (src/server/schema/blocks/external-app.schema.ts).
--
-- MANUAL APPLY. Migrations are not auto-applied to the main database: this file is committed for
-- history and a human runs the SQL below on each environment (preview / dev, then production).
-- CI and deploys do not run it.
--
-- DEPLOY ORDER: either order is safe. The column is marked no-type in `schema.full.prisma`, so
-- the generated Prisma client does not know it and no Prisma query can name it. It is read and
-- written by raw SQL in `app-listing-issue-tracker.service.ts` only: before this file is applied
-- every read there degrades to "no link" (no Support row, no listing-problems nudge), system
-- writes (on-site approve sync, shadow clone, revision apply) skip the column, and an author who
-- types a link is refused with PRECONDITION_FAILED, writing nothing.
--
-- LOCKING / SIZE: `ADD COLUMN <nullable, no default>` is a catalog-only change on Postgres 11+
-- (no table rewrite), so its ACCESS EXCLUSIVE lock on "app_listings" is held only for the
-- catalog update. `lock_timeout` bounds the wait for that lock, so a long-running reader makes
-- the apply fail (re-run it) instead of queueing every writer behind it.
--
-- Additive, nullable, no backfill, no index, no constraint. IF NOT EXISTS makes a re-run a no-op.
--
-- ROLLBACK: `ALTER TABLE "app_listings" DROP COLUMN IF EXISTS "issue_tracker_url";` — safe with
-- this code deployed (every read degrades to "no link"), and it discards the stored links.
--
-- Verify by reading back the column (`information_schema.columns`).
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "app_listings" ADD COLUMN IF NOT EXISTS "issue_tracker_url" TEXT;

COMMIT;
