-- AlterTable
ALTER TABLE "CosmeticShopItem" DROP COLUMN "unitValue",
ADD COLUMN     "unitAmount" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "UserCosmeticShopPurchases" DROP COLUMN "unitValue",
ADD COLUMN     "unitAmount" INTEGER NOT NULL;