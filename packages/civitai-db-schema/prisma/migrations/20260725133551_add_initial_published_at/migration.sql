-- Slice 0 of the paid-access refactor: a write-once "first published" anchor.
-- See docs/creator-studio/paid-access-implementation.md (§3). Applied manually.
--
-- The anchor never moves, so it can be the stable basis for the early-access window end
-- (replacing the expiry job's publishedAt-rewrite hack) and, later, age-based pricing.

-- AlterTable
ALTER TABLE "ModelVersion" ADD COLUMN "initialPublishedAt" TIMESTAMP(3);
ALTER TABLE "ComicChapter"  ADD COLUMN "initialPublishedAt" TIMESTAMP(3);

-- Backfill the true first-publish date. Expired early-access versions had "publishedAt"
-- rewritten to NOW() by process-ending-early-access, which stashed the original in
-- earlyAccessConfig.originalPublishedAt -- prefer that when present.
UPDATE "ModelVersion"
SET "initialPublishedAt" = COALESCE(("earlyAccessConfig" ->> 'originalPublishedAt')::timestamp, "publishedAt")
WHERE "initialPublishedAt" IS NULL AND "publishedAt" IS NOT NULL;

-- Comics has no resurface hack, so publishedAt is the first-publish date for already-published chapters.
UPDATE "ComicChapter"
SET "initialPublishedAt" = "publishedAt"
WHERE "initialPublishedAt" IS NULL AND "publishedAt" IS NOT NULL;
