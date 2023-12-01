-- AlterEnum
ALTER TYPE "CosmeticType" ADD VALUE 'ContentDecoration';

-- AlterTable
ALTER TABLE "Cosmetic" ADD COLUMN     "availableQuery" TEXT;

-- AlterTable
ALTER TABLE "UserCosmetic" ADD COLUMN     "data" JSONB;
