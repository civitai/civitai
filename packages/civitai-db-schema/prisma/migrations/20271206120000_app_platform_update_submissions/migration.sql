-- App Blocks: staff on-behalf submits of platform updates. When a moderator submits an app's
-- approved version with a platform update applied, for review on the owner's behalf
-- (`app-platform-update-submit.service.ts`), the update row records which publish request that
-- filed, who submitted it, and when. The publish request itself has the moderator as its
-- submitter and names the update under `file_summary.onBehalf`.
--
-- NOT AUTO-APPLIED: a human runs this file by hand, dev first, then production, AFTER
-- `20271205140000_app_platform_updates`. Until it exists the on-behalf submit refuses ("Platform
-- updates are not available"); the rest of the feature is unaffected.
--
-- Written and read by raw SQL only; the Prisma model is `@no-type`. Nullable columns with no
-- default and no foreign key: a catalog-only change, no table rewrite. Idempotent; safe to re-run.

SET lock_timeout = '5s';

ALTER TABLE "app_platform_updates"
    -- The publish request (pubreq_<ULID>) the last on-behalf submit of this update filed.
    ADD COLUMN IF NOT EXISTS "submitted_publish_request_id" TEXT,
    -- The moderator who submitted it. Resolved from the session, never from a request body.
    ADD COLUMN IF NOT EXISTS "submitted_by_user_id" INTEGER,
    ADD COLUMN IF NOT EXISTS "submitted_at" TIMESTAMPTZ(6);
