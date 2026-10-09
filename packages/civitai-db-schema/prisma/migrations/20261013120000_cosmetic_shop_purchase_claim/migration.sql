-- Idempotent: applied by hand, possibly more than once.
--
-- A claim on a shop or pack purchase's charge, written before the charge is made. See
-- src/server/services/shop-purchase-charge.ts for what each status means.
--
-- 🔴 APPLY BEFORE DEPLOYING the code that writes it. Every shop and pack purchase inserts a claim
-- first, so with the code live and this table missing, every purchase fails. Nothing is backfilled:
-- purchases made before the deploy have no claim and are not read through this table.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "CosmeticShopPurchaseClaim" (
  "transactionId" TEXT         NOT NULL,
  "userId"        INTEGER      NOT NULL,
  "shopItemId"    INTEGER      NOT NULL,
  "amount"        INTEGER      NOT NULL,
  "status"        TEXT         NOT NULL,
  "attempts"      INTEGER      NOT NULL DEFAULT 1,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CosmeticShopPurchaseClaim_pkey" PRIMARY KEY ("transactionId"),
  CONSTRAINT "CosmeticShopPurchaseClaim_status_check"
    CHECK ("status" IN ('pending', 'refunding', 'refunded', 'paid')),
  CONSTRAINT "CosmeticShopPurchaseClaim_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "CosmeticShopPurchaseClaim_attempts_check" CHECK ("attempts" >= 1)
);

-- Reconciliation reads claims left in pending or refunding past a cutoff.
CREATE INDEX IF NOT EXISTS "CosmeticShopPurchaseClaim_status_createdAt_idx"
  ON "CosmeticShopPurchaseClaim" ("status", "createdAt");

COMMIT;
