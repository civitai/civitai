-- AlterTable
-- Consumable balance for stickers. NULL means unlimited, which is what every
-- existing row is and stays — nothing needs backfilling, and every
-- non-consumable cosmetic keeps working untouched.
ALTER TABLE "UserCosmetic"
  ADD COLUMN IF NOT EXISTS "remaining" INTEGER;
