-- CreateTable: CryptoDeposit (replaces CryptoDepositFee)
CREATE TABLE "CryptoDeposit" (
    "paymentId" BIGINT NOT NULL,
    "userId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "payCurrency" TEXT NOT NULL,
    "payAmount" DOUBLE PRECISION,
    "outcomeAmount" DOUBLE PRECISION,
    "buzzCredited" INTEGER,
    "depositFee" DOUBLE PRECISION,
    "serviceFee" DOUBLE PRECISION,
    "feeCurrency" TEXT,
    "paidFiat" DOUBLE PRECISION,
    "chain" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CryptoDeposit_pkey" PRIMARY KEY ("paymentId")
);

-- CreateIndex
CREATE INDEX "CryptoDeposit_userId_createdAt_idx" ON "CryptoDeposit"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "CryptoDeposit" ADD CONSTRAINT "CryptoDeposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate data from CryptoDepositFee (best-effort, no userId available so skip)
-- CryptoDepositFee had no userId column, so we cannot migrate its data.

-- DropTable
DROP TABLE IF EXISTS "CryptoDepositFee";
