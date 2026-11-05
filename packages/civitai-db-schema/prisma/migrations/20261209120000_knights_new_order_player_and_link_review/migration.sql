-- Idempotent: applied by hand, possibly more than once.
-- Main-app tables: "NewOrderPlayer" columns and "NewOrderLinkReview", which the main app (grant job, detection job,
-- generated Prisma client), the moderator app and the Knights app read and write. Apply BEFORE deploying any of those three,
-- and before 20261210120000_knights_v2_tables. Applying it ahead of a deploy is harmless: every column is nullable or defaulted.
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
