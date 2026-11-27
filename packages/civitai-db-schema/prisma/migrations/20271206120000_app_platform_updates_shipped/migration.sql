-- App Blocks: platform updates, SHIPPED. A staff platform update is shipped once a version of the app
-- that contains it is approved: the approve sets these two columns for every update its bundle
-- contains. Until then every submit of the app checks the bundle for the update.
--
-- NOT AUTO-APPLIED: a human runs this file by hand, dev first, then production, after
-- 20271205140000_app_platform_updates. Until both exist the submit and approve checks are off (a
-- missing table or column reads as "no updates").
--
-- Additive and idempotent; safe to re-run. Both columns are nullable with no default, so the ALTER
-- is a catalog-only change and rewrites no rows.

SET lock_timeout = '5s';

ALTER TABLE "app_platform_updates"
    -- The approved publish request whose bundle first contained the update.
    ADD COLUMN IF NOT EXISTS "shipped_in_publish_request_id" TEXT,
    ADD COLUMN IF NOT EXISTS "shipped_at" TIMESTAMPTZ(6);
