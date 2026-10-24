-- Idempotent: applied by hand, possibly more than once.
--
-- Claimable Buzz prizes (crucibles and challenge winners). The winner picks green or yellow when
-- claiming on a site that offers both; an unclaimed prize is paid green at "autoClaimAt".
--
-- 🔴 APPLY BEFORE THE CODE DEPLOYS: crucible finalize and challenge completion write this table.

DO $$ BEGIN
  CREATE TYPE "PrizeSourceType" AS ENUM ('Crucible', 'Challenge');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "Prize" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "sourceType" "PrizeSourceType" NOT NULL,
  "sourceId" INTEGER NOT NULL,
  "subjectId" INTEGER,
  "position" INTEGER,
  "amount" INTEGER NOT NULL CHECK ("amount" > 0),
  "title" TEXT NOT NULL,
  "externalTransactionId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "autoClaimAt" TIMESTAMP(3) NOT NULL,
  "claimedAt" TIMESTAMP(3),
  "buzzType" TEXT CHECK ("buzzType" IN ('green', 'yellow')),
  "autoClaimed" BOOLEAN NOT NULL DEFAULT false,
  "paidAt" TIMESTAMP(3),
  "voidedAt" TIMESTAMP(3),
  CONSTRAINT "Prize_claim_consistent" CHECK (("claimedAt" IS NULL) = ("buzzType" IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "Prize_externalTransactionId_key" ON "Prize"("externalTransactionId");
CREATE INDEX IF NOT EXISTS "Prize_userId_idx" ON "Prize"("userId");
CREATE INDEX IF NOT EXISTS "Prize_sourceType_sourceId_idx" ON "Prize"("sourceType", "sourceId");
-- The auto-pay job's two scans.
CREATE INDEX IF NOT EXISTS "Prize_autoClaimAt_unclaimed_idx" ON "Prize"("autoClaimAt")
  WHERE "claimedAt" IS NULL AND "voidedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "Prize_claimedAt_unpaid_idx" ON "Prize"("claimedAt")
  WHERE "claimedAt" IS NOT NULL AND "paidAt" IS NULL AND "voidedAt" IS NULL;
