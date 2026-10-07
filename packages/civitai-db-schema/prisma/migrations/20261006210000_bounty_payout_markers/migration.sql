-- Additive and nullable. Rows awarded or refunded before the deploy stay NULL and are never retried.
-- Apply by hand, outside a transaction (the index is built CONCURRENTLY). Every statement is
-- idempotent: re-run the file after a lock timeout.
SET lock_timeout = '3s';
ALTER TABLE "Bounty"
  ADD COLUMN IF NOT EXISTS "payoutRecordedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "payoutSettledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "payoutWinnerUserId" INTEGER;
RESET lock_timeout;

-- The retry job's query repeats this predicate.
-- A CONCURRENTLY build that fails part-way leaves an INVALID index that IF NOT EXISTS then skips.
-- This must return true afterwards:
--   SELECT indisvalid FROM pg_index WHERE indexrelid = '"Bounty_unsettled_payout_idx"'::regclass;
-- If it returns false: DROP INDEX CONCURRENTLY IF EXISTS "Bounty_unsettled_payout_idx"; and re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Bounty_unsettled_payout_idx" ON "Bounty" ("payoutRecordedAt")
  WHERE "payoutRecordedAt" IS NOT NULL AND "payoutSettledAt" IS NULL;
