-- Gift memberships become N months of a tier, consumed one month at a time.
-- Applied by hand (we do not run `prisma migrate deploy`).
--
-- ============================================================================
-- RUN PART 1 ANY TIME. RUN PART 2 ONLY WHEN THE CODE IS DEPLOYED.
-- ============================================================================
--
-- Part 1 is additive: new enum values, new columns, an index and a foreign key.
-- Nothing running today reads any of it, so it is safe ahead of the deploy.
--
-- Part 2 rewrites the status of gifts that were fulfilled under the OLD design.
-- The currently deployed `getMyMembershipGifts` lists a user's received gifts with
-- `status = 'Fulfilled'`, so running Part 2 early makes those gifts disappear from
-- /user/account and /user/membership for the people who hold them, until the new
-- code ships. Run it in the same window as the deploy, not before.
--
-- DO NOT WRAP EITHER PART IN AN EXPLICIT BEGIN/COMMIT. Postgres refuses to use an
-- enum value that was added in the same transaction, so Part 2's UPDATE fails with
-- "unsafe use of new value of enum type" unless Part 1 has already committed.
-- psql's default autocommit is what you want.

-- ============================== PART 1 ======================================

ALTER TYPE "MembershipGiftStatus" ADD VALUE IF NOT EXISTS 'Active' AFTER 'Fulfilled';
ALTER TYPE "MembershipGiftStatus" ADD VALUE IF NOT EXISTS 'Completed' AFTER 'Active';

ALTER TABLE "MembershipGift"
  ADD COLUMN IF NOT EXISTS "holderId" INTEGER,
  ADD COLUMN IF NOT EXISTS "monthsRemaining" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "monthsConsumed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "acceptedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "armedCouponId" TEXT,
  ADD COLUMN IF NOT EXISTS "armedAt" TIMESTAMP(3);

-- The holder is whoever the gift was sent to. Gifts are not transferable yet; every
-- read asks "is this gift mine" through holderId so that stays a one-line change.
UPDATE "MembershipGift" SET "holderId" = "recipientId" WHERE "holderId" IS NULL;

ALTER TABLE "MembershipGift" ALTER COLUMN "holderId" SET NOT NULL;

ALTER TABLE "MembershipGift"
  DROP CONSTRAINT IF EXISTS "MembershipGift_holderId_fkey";
ALTER TABLE "MembershipGift"
  ADD CONSTRAINT "MembershipGift_holderId_fkey"
  FOREIGN KEY ("holderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "MembershipGift_holderId_status_idx" ON "MembershipGift"("holderId", "status");
CREATE INDEX IF NOT EXISTS "MembershipGift_armedCouponId_idx" ON "MembershipGift"("armedCouponId");

-- ============================== PART 2 ======================================
-- Deploy-time only. See the header.
--
-- Rows fulfilled under the old design already had their whole value applied as a
-- single multi-month coupon, so they are Completed with nothing left to consume.
-- Leaving them 'Fulfilled' would put them in the new gift queue as unaccepted, and
-- accepting one would arm a second discount on top of a coupon that is still running.
-- As of 2026-08-14 this is 9 rows in production.

UPDATE "MembershipGift"
SET "status" = 'Completed', "monthsConsumed" = "months", "monthsRemaining" = 0
WHERE "status" = 'Fulfilled';
