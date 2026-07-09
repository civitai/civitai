-- DropForeignKey
ALTER TABLE "CustomerSubscription" DROP CONSTRAINT "CustomerSubscription_userId_fkey";

-- AlterTable
ALTER TABLE "Cosmetic" ADD COLUMN     "availableEnd" TIMESTAMP(3),
ADD COLUMN     "availableStart" TIMESTAMP(3),
ADD COLUMN     "productId" TEXT;

-- AddForeignKey
ALTER TABLE "CustomerSubscription" ADD CONSTRAINT "CustomerSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
