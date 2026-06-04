-- CreateTable
CREATE TABLE "UserPaymentConfiguration" (
    "userId" INTEGER NOT NULL,
    "tipaltiAccountId" TEXT NOT NULL,
    "tipaltiAccountStatus" TEXT NOT NULL DEFAULT 'INTERNAL_VALUE',
    "tipaltiPaymentsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "chargesEnabled" BOOLEAN NOT NULL DEFAULT false
);

-- CreateIndex
CREATE UNIQUE INDEX "UserPaymentConfiguration_userId_key" ON "UserPaymentConfiguration"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserPaymentConfiguration_tipaltiAccountId_key" ON "UserPaymentConfiguration"("tipaltiAccountId");
 
-- AddForeignKey
ALTER TABLE "UserPaymentConfiguration" ADD CONSTRAINT "UserPaymentConfiguration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;