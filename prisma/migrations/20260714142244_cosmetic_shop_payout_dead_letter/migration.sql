-- Dead-letter record for cosmetic shop creator payouts (bank -> creator) that failed after
-- the buyer was already charged. No foreign keys on purpose: these rows are a record of buzz
-- still owed, so they must outlive deletion of the shop item, cosmetic, or purchase row.
CREATE TABLE IF NOT EXISTS "CosmeticShopPayoutDeadLetter" (
  "id" SERIAL NOT NULL,
  "externalTransactionId" TEXT NOT NULL,
  "purchaseTransactionId" TEXT NOT NULL,
  "recipientUserId" INTEGER NOT NULL,
  "buyerId" INTEGER NOT NULL,
  "shopItemId" INTEGER NOT NULL,
  "cosmeticId" INTEGER NOT NULL,
  "amount" INTEGER NOT NULL,
  "originalAmount" INTEGER NOT NULL,
  "buzzType" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CosmeticShopPayoutDeadLetter_pkey" PRIMARY KEY ("id")
);

-- The buzz service treats externalTransactionId as the idempotency key, so it also uniquely
-- identifies the debt: re-recording the same failed payout must update, never insert.
CREATE UNIQUE INDEX IF NOT EXISTS "CosmeticShopPayoutDeadLetter_externalTransactionId_key"
  ON "CosmeticShopPayoutDeadLetter"("externalTransactionId");

CREATE INDEX IF NOT EXISTS "CosmeticShopPayoutDeadLetter_resolvedAt_idx"
  ON "CosmeticShopPayoutDeadLetter"("resolvedAt");
