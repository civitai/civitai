-- AlterTable
ALTER TABLE "CosmeticShopSection" ADD COLUMN     "published" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "UserCosmetic" ADD COLUMN     "forId" INTEGER,
ADD COLUMN     "forType" "CosmeticEntity";
