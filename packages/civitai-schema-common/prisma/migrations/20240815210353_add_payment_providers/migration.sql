-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('Stripe', 'Paddle');

-- DropForeignKey
ALTER TABLE "Purchase" DROP CONSTRAINT "Purchase_customerId_fkey";

-- AlterTable
ALTER TABLE "Price" ADD COLUMN     "provider" "PaymentProvider" NOT NULL DEFAULT 'Stripe';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "provider" "PaymentProvider" NOT NULL DEFAULT 'Stripe';

-- AlterTable
ALTER TABLE "Purchase" ADD COLUMN     "userId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "Purchase" ALTER COLUMN "customerId" DROP NOT NULL;


-- Update all the existing rows in the Purchase table to have the correct userId
UPDATE "Purchase" p
SET "userId" = u.id
FROM "User" u
WHERE p."customerId" = u."customerId";

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ONLY REMOVE AFTER CONFIRMING THAT THE UPDATE WORKED
ALTER TABLE "Purchase" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "Purchase" DROP COLUMN "customerId";