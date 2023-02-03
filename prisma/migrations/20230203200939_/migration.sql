/*
  Warnings:

  - A unique constraint covering the columns `[customerId]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
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
CREATE UNIQUE INDEX "User_customerId_key" ON "User"("customerId");

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("customerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_priceId_fkey" FOREIGN KEY ("priceId") REFERENCES "Price"("id") ON DELETE SET NULL ON UPDATE CASCADE;
