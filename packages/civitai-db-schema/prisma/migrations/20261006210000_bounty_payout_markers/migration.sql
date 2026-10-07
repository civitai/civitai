-- Additive and nullable. Rows awarded or refunded before the deploy stay NULL and are never retried.
ALTER TABLE "Bounty"
  ADD COLUMN "payoutRecordedAt" TIMESTAMP(3),
  ADD COLUMN "payoutSettledAt" TIMESTAMP(3);

-- The retry job's query repeats this predicate.
CREATE INDEX "Bounty_unsettled_payout_idx" ON "Bounty" ("payoutRecordedAt")
  WHERE "payoutRecordedAt" IS NOT NULL AND "payoutSettledAt" IS NULL;
