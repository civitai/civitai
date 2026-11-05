-- Idempotent: applied by hand, possibly more than once.
-- Main-app tables, read and written by the main app, the moderator app and Knights. Apply BEFORE deploying any of them; deploy the main app no later than Knights
-- (a reset on the previous main app does not zero "goldEarned").
ALTER TABLE "NewOrderPlayer"
  ADD COLUMN IF NOT EXISTS "payoutBlockedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "payoutBlockReason" TEXT,
  ADD COLUMN IF NOT EXISTS "payoutBlockedBy" INTEGER,
  ADD COLUMN IF NOT EXISTS "payoutReleaseFrom" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "goldPending" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "goldEarned" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "goldConverted" INTEGER NOT NULL DEFAULT 0;

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
