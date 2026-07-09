-- CreateEnum
CREATE TYPE "CosmeticEntity" AS ENUM ('Model', 'Image', 'Article', 'Post');

-- AlterTable
ALTER TABLE "UserCosmetic" DROP CONSTRAINT "UserCosmetic_pkey",
ADD COLUMN     "claimKey" TEXT NOT NULL DEFAULT 'claimed',
ADD COLUMN     "equippedToId" INTEGER,
ADD COLUMN     "equippedToType" "CosmeticEntity",
ADD CONSTRAINT "UserCosmetic_pkey" PRIMARY KEY ("userId", "cosmeticId", "claimKey");

-- CreateTable
CREATE TABLE "CosmeticShopSection" (
    "id" SERIAL NOT NULL,
    "addedById" INTEGER,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "placement" INTEGER NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "imageId" INTEGER NOT NULL,

    CONSTRAINT "CosmeticShopSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CosmeticShopItem" (
    "id" SERIAL NOT NULL,
    "cosmeticId" INTEGER NOT NULL,
    "unitValue" INTEGER NOT NULL,
    "addedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "availableFrom" TIMESTAMP(3),
    "availableTo" TIMESTAMP(3),
    "availableQuantity" INTEGER,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "CosmeticShopItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CosmeticShopSectionItem" (
    "shopItemId" INTEGER NOT NULL,
    "shopSectionId" INTEGER NOT NULL,
    "index" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CosmeticShopSectionItem_pkey" PRIMARY KEY ("shopItemId","shopSectionId")
);

-- CreateTable
CREATE TABLE "UserCosmeticShopPurchases" (
    "userId" INTEGER NOT NULL,
    "cosmeticId" INTEGER NOT NULL,
    "shopItemId" INTEGER NOT NULL,
    "unitValue" INTEGER NOT NULL,
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "buzzTransactionId" TEXT NOT NULL,
    "refunded" BOOLEAN NOT NULL,

    CONSTRAINT "UserCosmeticShopPurchases_pkey" PRIMARY KEY ("buzzTransactionId")
);

-- AddForeignKey
ALTER TABLE "CosmeticShopSection" ADD CONSTRAINT "CosmeticShopSection_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CosmeticShopSection" ADD CONSTRAINT "CosmeticShopSection_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CosmeticShopItem" ADD CONSTRAINT "CosmeticShopItem_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CosmeticShopSectionItem" ADD CONSTRAINT "CosmeticShopSectionItem_shopItemId_fkey" FOREIGN KEY ("shopItemId") REFERENCES "CosmeticShopItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CosmeticShopSectionItem" ADD CONSTRAINT "CosmeticShopSectionItem_shopSectionId_fkey" FOREIGN KEY ("shopSectionId") REFERENCES "CosmeticShopSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCosmeticShopPurchases" ADD CONSTRAINT "UserCosmeticShopPurchases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCosmeticShopPurchases" ADD CONSTRAINT "UserCosmeticShopPurchases_cosmeticId_fkey" FOREIGN KEY ("cosmeticId") REFERENCES "Cosmetic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCosmeticShopPurchases" ADD CONSTRAINT "UserCosmeticShopPurchases_shopItemId_fkey" FOREIGN KEY ("shopItemId") REFERENCES "CosmeticShopItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
