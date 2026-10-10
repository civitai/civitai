-- Gift memberships become N months of a tier, consumed one month at a time.
-- Applied by hand (we do not run `prisma migrate deploy`).
--
-- ============================================================================
-- RUN PART 1 BEFORE THE DEPLOY. RUN PART 2 ONLY AFTER IT HAS FULLY ROLLED OUT.
-- ============================================================================
--
-- Part 1 is additive: new enum values, new nullable/defaulted columns, an index and a
-- foreign key. Nothing running today reads any of it, and the build that is live today
-- can keep inserting gifts while it is in place, so it is safe at any point ahead of the
-- deploy. The new build reads these columns, so it must not ship without them.
--
-- Part 2 needs every pod to be on the new build, for three reasons:
--   * It makes "holderId" NOT NULL. The previous build inserts gifts without it, so
--     while any old pod is serving, that constraint fails every gift purchase.
--   * It writes the new 'Completed' status. The previous build's Prisma client does not
--     know that label and throws on reading a row that carries it.
--   * The previous build lists a user's received gifts with status = 'Fulfilled', so
--     those gifts would disappear from /user/account for the people who hold them.
--
-- Nothing else depends on when Part 2 runs: until it does, gifts fulfilled under the old
-- design read as received rather than used.
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

ALTER TABLE "MembershipGift"
  DROP CONSTRAINT IF EXISTS "MembershipGift_holderId_fkey";
ALTER TABLE "MembershipGift"
  ADD CONSTRAINT "MembershipGift_holderId_fkey"
  FOREIGN KEY ("holderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "MembershipGift_holderId_status_idx" ON "MembershipGift"("holderId", "status");
CREATE INDEX IF NOT EXISTS "MembershipGift_armedCouponId_idx" ON "MembershipGift"("armedCouponId");

-- ============================== PART 2 ======================================
-- After the deploy only. See the header.

-- Gifts the previous build created between Part 1 and the end of the rollout.
UPDATE "MembershipGift" SET "holderId" = "recipientId" WHERE "holderId" IS NULL;

ALTER TABLE "MembershipGift" ALTER COLUMN "holderId" SET NOT NULL;

-- Rows fulfilled under the old design already had their whole value applied as a
-- single multi-month coupon, so they are Completed with nothing left to consume.
--
-- "monthsRemaining" = 0 is what tells them apart from gifts the new build has already
-- queued: the new build sets it to the gift's months when it records the payment.

UPDATE "MembershipGift"
SET "status" = 'Completed', "monthsConsumed" = "months"
WHERE "status" = 'Fulfilled' AND "monthsRemaining" = 0;
