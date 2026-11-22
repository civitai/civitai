-- Marks a version whose licensor is paid by invoice: the daily creator payout mints none of its licence
-- fee, so it cannot also reach a withdrawable balance. Staff set it by hand.
--
-- Apply BEFORE the deploy: the payout job selects "licensingFeePaidByInvoice". A constant default on
-- PostgreSQL 11+ is a catalog-only change, so the table is not rewritten.
ALTER TABLE "ModelVersion" ADD COLUMN IF NOT EXISTS "licensingFeePaidByInvoice" BOOLEAN NOT NULL DEFAULT false;
