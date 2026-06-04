/*
  Warnings:

  - A unique constraint covering the columns `[customerId]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "customerId" TEXT,
ADD COLUMN     "subscriptionId" TEXT;

-- CreateTable
CREATE TABLE "CustomerSubscription" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "metadata" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "priceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL,
    "cancelAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "CustomerSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "metadata" JSONB NOT NULL,
    "defaultPriceId" TEXT,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Price" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,
    "currency" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "unitAmount" INTEGER,
    "interval" TEXT,
    "intervalCount" INTEGER,
    "metadata" JSONB NOT NULL,

    CONSTRAINT "Price_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Purchase" (
    "id" SERIAL NOT NULL,
    "customerId" TEXT NOT NULL,
    "productId" TEXT,
    "priceId" TEXT,
    "status" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerSubscription_userId_key" ON "CustomerSubscription"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "User_customerId_key" ON "User"("customerId");

-- AddForeignKey
ALTER TABLE "CustomerSubscription" ADD CONSTRAINT "CustomerSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerSubscription" ADD CONSTRAINT "CustomerSubscription_priceId_fkey" FOREIGN KEY ("priceId") REFERENCES "Price"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerSubscription" ADD CONSTRAINT "CustomerSubscription_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Price" ADD CONSTRAINT "Price_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("customerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_priceId_fkey" FOREIGN KEY ("priceId") REFERENCES "Price"("id") ON DELETE SET NULL ON UPDATE CASCADE;
