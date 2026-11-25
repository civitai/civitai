-- Feature Pages: what a moderator's dismissal of a scan's hide may lift, and what the mirror last
-- sent as a moderator hide. Nullable, no defaults, no backfill: rows hidden before these columns
-- existed have no scan hide recorded, so nothing lifts them. Apply BEFORE deploying the code that
-- writes them: that code writes them on every Feature Pages hide.
-- Expects 20271125140000_feature_page_comments to be applied already.
BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE "FeaturePageCommentMirror"
  ADD COLUMN IF NOT EXISTS "scanHiddenAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "scanHiddenVersion" INTEGER,
  ADD COLUMN IF NOT EXISTS "scanHideReportId" INTEGER,
  ADD COLUMN IF NOT EXISTS "modHideSentAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "modHideOrigin" TEXT,
  ADD COLUMN IF NOT EXISTS "liftGrantedAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "liftGrantedBy" INTEGER,
  ADD COLUMN IF NOT EXISTS "liftGrantedVersion" INTEGER;
ALTER TABLE "FeaturePageCommentMirror"
  DROP CONSTRAINT IF EXISTS "FeaturePageCommentMirror_modHideOrigin_check";
ALTER TABLE "FeaturePageCommentMirror"
  ADD CONSTRAINT "FeaturePageCommentMirror_modHideOrigin_check"
  CHECK ("modHideOrigin" IS NULL OR "modHideOrigin" IN ('scan', 'moderator', 'foreign'));
COMMIT;
