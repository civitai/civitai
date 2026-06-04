-- Add retryCount column for buzz grant retry tracking
ALTER TABLE "CryptoDeposit" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;

-- Index on status for efficient retry sweep queries
CREATE INDEX "CryptoDeposit_status_idx" ON "CryptoDeposit"("status");
