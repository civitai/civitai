-- Creator Shop foundations.
-- Extends the existing cosmetic-shop model for creator-submitted cosmetics:
--   * Cosmetic authorship (createdById)
--   * per-listing review lifecycle (status + reviewer/reason) on CosmeticShopItem
-- Per-creator shop settings live in "User".settings JSON (no schema change).
-- Apply manually (we do NOT run `prisma migrate deploy`).

-- 1. Review lifecycle status for shop listings.
CREATE TYPE "CosmeticShopItemStatus" AS ENUM (
  'Draft', 'PendingReview', 'Published', 'Rejected', 'Archived'
);

-- 2. Cosmetic authorship. NULL = official / admin-authored cosmetic (unchanged).
ALTER TABLE "Cosmetic" ADD COLUMN "createdById" INTEGER;

ALTER TABLE "Cosmetic"
  ADD CONSTRAINT "Cosmetic_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Cosmetic_createdById_idx" ON "Cosmetic"("createdById");

-- 3. Per-listing review state on CosmeticShopItem.
--    Default 'Published' so existing moderator-curated items are unaffected and
--    no backfill is required.
ALTER TABLE "CosmeticShopItem"
  ADD COLUMN "status" "CosmeticShopItemStatus" NOT NULL DEFAULT 'Published',
  ADD COLUMN "reviewedById" INTEGER,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "rejectionReason" TEXT;
