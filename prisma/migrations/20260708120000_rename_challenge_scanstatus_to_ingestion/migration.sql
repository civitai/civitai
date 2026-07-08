-- Rename Challenge.scanStatus -> ingestion (and its enum + index) to match the convention used by
-- the other scanned entities (Image.ingestion / ImageIngestionStatus, Article.ingestion /
-- ArticleIngestionStatus). All three statements are metadata-only, instant, and safe on a populated
-- table. Follows the original public_challenges_v1_schema migration, which created "scanStatus".
ALTER TYPE "ChallengeScanStatus" RENAME TO "ChallengeIngestionStatus";
ALTER TABLE "Challenge" RENAME COLUMN "scanStatus" TO "ingestion";
ALTER INDEX "Challenge_status_scanStatus_idx" RENAME TO "Challenge_status_ingestion_idx";
