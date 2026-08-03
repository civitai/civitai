-- AlterTable
-- Delisted = still Published (so edit rules, review workflow and resale keep
-- working) but withdrawn from individual sale. Existing rows are all listed.
ALTER TABLE "CosmeticShopItem"
  ADD COLUMN IF NOT EXISTS "listed" BOOLEAN NOT NULL DEFAULT true;
