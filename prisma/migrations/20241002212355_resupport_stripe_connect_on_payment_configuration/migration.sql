-- CreateEnum
CREATE TYPE "UserPaymentConfigurationProvider" AS ENUM ('Stripe', 'Tipalti');

-- AlterTable
ALTER TABLE "BuzzWithdrawalRequest" DROP COLUMN "requestedToProvider",
ADD COLUMN     "requestedToProvider" "UserPaymentConfigurationProvider" NOT NULL DEFAULT 'Stripe';

-- AlterTable
ALTER TABLE "UserPaymentConfiguration" DROP COLUMN "chargesEnabled",
DROP COLUMN "payoutsEnabled",
ALTER COLUMN "tipaltiAccountId" DROP NOT NULL,
ADD COLUMN     "stripeAccountId" TEXT,
ADD COLUMN     "stripeAccountStatus" TEXT NOT NULL DEFAULT 'Pending',
ADD COLUMN     "stripePaymentsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- TODO FIX
INSERT INTO "UserPaymentConfiguration" ("userId", "stripeAccountId", "stripeAccountStatus", "stripePaymentsEnabled")
SELECT "userId", "id", "stripeAcc", "paymentsEnabled"
FROM "UserStripeConnect";
 
 -- DropForeignKey
ALTER TABLE "UserStripeConnect" DROP CONSTRAINT "UserStripeConnect_userId_fkey";

-- DropTable
DROP TABLE "UserStripeConnect";

-- DropEnum
DROP TYPE "StripeConnectStatus";
