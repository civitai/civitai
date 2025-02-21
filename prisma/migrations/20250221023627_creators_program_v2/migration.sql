-- CreateEnum
CREATE TYPE "CashWithdrawalStatus" AS ENUM ('Paid', 'Rejected', 'Scheduled', 'Submitted', 'Deferred', 'DeferredInternal', 'Canceled', 'Cleared', 'FraudReview', 'PendingPayerFunds', 'InternalValue', 'FailedFee');

-- CreateEnum
CREATE TYPE "CashWithdrawalMethod" AS ENUM ('NotProvided', 'WireTransfer', 'Payoneer', 'PayPal', 'ACH', 'Check', 'ECheck', 'HoldPayments', 'Custom', 'Intercash', 'Card', 'TipaltiInternalValue');

-- CreateTable
CREATE TABLE "CashWithdrawal" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT,
    "userId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "method" "CashWithdrawalMethod" NOT NULL,
    "fee" INTEGER NOT NULL,
    "status" "CashWithdrawalStatus" NOT NULL,
    "note" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CashWithdrawal_transactionId_key" ON "CashWithdrawal"("transactionId");

-- CreateIndex
CREATE INDEX "CashWithdrawal_userId_idx" ON "CashWithdrawal"("userId");

-- AddForeignKey
ALTER TABLE "CashWithdrawal" ADD CONSTRAINT "CashWithdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;