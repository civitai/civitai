-- Idempotent: applied by hand, possibly more than once.
--
-- A "CreatorMilestone" row can carry its own detector, so a milestone can be defined without a code
-- change. The grant-creator-milestones job reads it; no API response may select it.

SET lock_timeout = '3s';

ALTER TABLE "CreatorMilestone" ADD COLUMN IF NOT EXISTS "detector" JSONB;
