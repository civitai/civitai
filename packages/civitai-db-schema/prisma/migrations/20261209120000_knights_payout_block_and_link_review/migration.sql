-- Idempotent: applied by hand, possibly more than once.
-- Apply BEFORE deploying: the grant job reads the payout-block columns and the detection job writes the review table.
ALTER TABLE "NewOrderPlayer"
  ADD COLUMN IF NOT EXISTS "payoutBlockedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "payoutBlockReason" TEXT,
  ADD COLUMN IF NOT EXISTS "payoutBlockedBy" INTEGER,
  ADD COLUMN IF NOT EXISTS "payoutReleaseFrom" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "NewOrderLinkReview" (
  "id" SERIAL PRIMARY KEY,
  "fingerprint" TEXT NOT NULL,
  "userIds" INTEGER[] NOT NULL,
  "evidence" JSONB NOT NULL,
  "buzzMoved" INTEGER NOT NULL DEFAULT 0,
  "autoBlocked" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'Pending',
  "reviewedBy" INTEGER,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "NewOrderLinkReview_fingerprint_key" ON "NewOrderLinkReview" ("fingerprint");
CREATE INDEX IF NOT EXISTS "NewOrderLinkReview_status_createdAt_idx" ON "NewOrderLinkReview" ("status", "createdAt");
