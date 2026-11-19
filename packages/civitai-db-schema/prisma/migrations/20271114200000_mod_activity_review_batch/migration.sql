-- The review batch a media view was served from, its tier, and whether the batch was declared suspect.
-- NULL on every existing row and every other writer. No signal names, labels or scores are stored.
--
-- HAND-APPLIED. Apply, and read back, BEFORE the release that ships the regenerated client: Prisma
-- returns every scalar from a ModActivity create, so main-app writes fail while a column is missing.
-- Read-back must return 3:
--   SELECT count(*) FROM information_schema.columns
--   WHERE table_name = 'ModActivity'
--     AND column_name IN ('reviewBatchId', 'reviewTier', 'declaredSuspect');
--
-- Nullable, no default and no FK, and the CHECK is NOT VALID, so nothing scans or rewrites the table.
-- It still needs a brief ACCESS EXCLUSIVE lock on "ModActivity": re-run on lock timeout.
--
-- Never drop these columns while a release carrying the regenerated client is live. To revert after
-- that release is gone:
--   ALTER TABLE "ModActivity" DROP CONSTRAINT IF EXISTS "ModActivity_reviewTier_check";
--   ALTER TABLE "ModActivity" DROP COLUMN IF EXISTS "reviewBatchId";
--   ALTER TABLE "ModActivity" DROP COLUMN IF EXISTS "reviewTier";
--   ALTER TABLE "ModActivity" DROP COLUMN IF EXISTS "declaredSuspect";

BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE "ModActivity" ADD COLUMN IF NOT EXISTS "reviewBatchId" TEXT;
ALTER TABLE "ModActivity" ADD COLUMN IF NOT EXISTS "reviewTier" TEXT;
ALTER TABLE "ModActivity" ADD COLUMN IF NOT EXISTS "declaredSuspect" BOOLEAN;
ALTER TABLE "ModActivity" DROP CONSTRAINT IF EXISTS "ModActivity_reviewTier_check";
ALTER TABLE "ModActivity" ADD CONSTRAINT "ModActivity_reviewTier_check"
  CHECK ("reviewTier" IN ('general', 'held')) NOT VALID;
COMMIT;
