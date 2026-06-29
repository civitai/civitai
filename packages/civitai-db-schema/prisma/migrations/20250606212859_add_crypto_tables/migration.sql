BEGIN;
-- CreateEnum
CREATE TYPE "CryptoTransactionStatus" AS ENUM ('WaitingForRamp', 'RampTimedOut', 'RampFailed', 'RampInProgress', 'RampSuccess', 'WaitingForSweep', 'SweepFailed', 'Complete');
COMMIT;

BEGIN;
-- AlterEnum
ALTER TYPE "Currency" ADD VALUE 'USDC';
COMMIT;

BEGIN;
-- CreateTable
CREATE TABLE "CryptoWallet" (
    "userId" INTEGER NOT NULL,
    "wallet" TEXT NOT NULL,
    "smartAccount" TEXT,

    CONSTRAINT "CryptoWallet_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "CryptoTransaction" (
    "key" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "status" "CryptoTransactionStatus" NOT NULL DEFAULT 'WaitingForRamp',
    "amount" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'USDC',
    "sweepTxHash" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CryptoTransaction_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "CryptoWallet_wallet_key" ON "CryptoWallet"("wallet");

-- CreateIndex
CREATE UNIQUE INDEX "CryptoWallet_smartAccount_key" ON "CryptoWallet"("smartAccount");

-- AddForeignKey
ALTER TABLE "CryptoWallet" ADD CONSTRAINT "CryptoWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CryptoTransaction" ADD CONSTRAINT "CryptoTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
COMMIT;