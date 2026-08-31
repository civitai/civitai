-- CreateEnum
CREATE TYPE "ShopifyMerchOrderStatus" AS ENUM ('Pending', 'Granted');

-- CreateTable
CREATE TABLE "ShopifyCustomerLink" (
    "id" SERIAL NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifyCustomerLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyMerchOrder" (
    "id" SERIAL NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "shopifyCustomerId" TEXT,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "couponCodes" TEXT[],
    "buzzAmount" INTEGER NOT NULL,
    "status" "ShopifyMerchOrderStatus" NOT NULL DEFAULT 'Pending',
    "userId" INTEGER,
    "grantedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifyMerchOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyCustomerLink_shopifyCustomerId_key" ON "ShopifyCustomerLink"("shopifyCustomerId");
CREATE INDEX "ShopifyCustomerLink_email_idx" ON "ShopifyCustomerLink"("email");
CREATE INDEX "ShopifyCustomerLink_userId_idx" ON "ShopifyCustomerLink"("userId");
CREATE UNIQUE INDEX "ShopifyMerchOrder_shopifyOrderId_key" ON "ShopifyMerchOrder"("shopifyOrderId");
CREATE INDEX "ShopifyMerchOrder_email_idx" ON "ShopifyMerchOrder"("email");
CREATE INDEX "ShopifyMerchOrder_userId_idx" ON "ShopifyMerchOrder"("userId");

-- AddForeignKey
ALTER TABLE "ShopifyCustomerLink" ADD CONSTRAINT "ShopifyCustomerLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShopifyMerchOrder" ADD CONSTRAINT "ShopifyMerchOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
