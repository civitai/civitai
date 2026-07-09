-- AlterTable
ALTER TABLE "BuzzClaim"
ADD COLUMN     "claimed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "limit" INTEGER;
