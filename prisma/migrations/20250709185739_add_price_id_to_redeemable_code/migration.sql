-- AlterEnum
ALTER TYPE "PaymentProvider" ADD VALUE 'Civitai';
 
-- AlterTable
ALTER TABLE "RedeemableCode" ADD COLUMN     "priceId" TEXT;
 
-- AddForeignKey
ALTER TABLE "RedeemableCode" ADD CONSTRAINT "RedeemableCode_priceId_fkey" FOREIGN KEY ("priceId") REFERENCES "Price"("id") ON DELETE SET NULL ON UPDATE CASCADE;
 