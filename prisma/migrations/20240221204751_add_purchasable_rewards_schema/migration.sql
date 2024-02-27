-- CreateEnum
CREATE TYPE "PurchasableRewardUsage" AS ENUM ('SingleUse', 'MultiUse');

-- CreateTable
CREATE TABLE "PurchasableReward" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "about" TEXT NOT NULL,
    "redeemDetails" TEXT NOT NULL,
    "termsOfUse" TEXT NOT NULL,
    "usage" "PurchasableRewardUsage" NOT NULL,
    "codes" TEXT[],
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "availableFrom" TIMESTAMP(3),
    "availableTo" TIMESTAMP(3),
    "availableCount" INTEGER,
    "addedById" INTEGER,
    "coverImageId" INTEGER,

    CONSTRAINT "PurchasableReward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPurchasedRewards" (
    "buzzTransactionId" TEXT NOT NULL,
    "userId" INTEGER,
    "purchasableRewardId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "code" TEXT NOT NULL,

    CONSTRAINT "UserPurchasedRewards_pkey" PRIMARY KEY ("buzzTransactionId")
);

-- AddForeignKey
ALTER TABLE "PurchasableReward" ADD CONSTRAINT "PurchasableReward_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchasableReward" ADD CONSTRAINT "PurchasableReward_coverImageId_fkey" FOREIGN KEY ("coverImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPurchasedRewards" ADD CONSTRAINT "UserPurchasedRewards_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPurchasedRewards" ADD CONSTRAINT "UserPurchasedRewards_purchasableRewardId_fkey" FOREIGN KEY ("purchasableRewardId") REFERENCES "PurchasableReward"("id") ON DELETE SET NULL ON UPDATE CASCADE;
