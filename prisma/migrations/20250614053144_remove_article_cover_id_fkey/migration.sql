BEGIN;
CREATE INDEX CONCURRENTLY "Image_blocked_idx" ON "Image" ("ingestion", "blockedFor") WHERE "ingestion" = 'Blocked' AND "blockedFor" != 'AiNotVerified';
COMMIT;

BEGIN;
-- DropForeignKey
ALTER TABLE "Article" DROP CONSTRAINT "Article_coverId_fkey";
COMMIT;