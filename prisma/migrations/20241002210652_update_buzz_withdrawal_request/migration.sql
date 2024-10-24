
-- AlterTable
ALTER TABLE "BuzzWithdrawalRequest" ADD COLUMN     "requestedToId" TEXT,
ADD COLUMN     "requestedToProvider" TEXT NOT NULL DEFAULT 'Stripe',
ALTER COLUMN "connectedAccountId" DROP NOT NULL;

UPDATE "BuzzWithdrawalRequest" SET "requestedToId" = "connectedAccountId";

ALTER TABLE "BuzzWithdrawalRequest" ALTER COLUMN "requestedToId" SET NOT NULL, DROP COLUMN "connectedAccountId";
