-- A removed deal file whose row and objects must stay. Applied by hand, BEFORE the deploy that
-- reads it. Additive: one nullable column, no backfill.
ALTER TABLE "ServiceDealFile" ADD COLUMN IF NOT EXISTS "removedAt" TIMESTAMP(3);
