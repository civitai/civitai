-- Gift memberships become N months of a tier, consumed one month at a time.
-- Applied by hand (we do not run `prisma migrate deploy`).
--
-- RUN THIS FILE STATEMENT BY STATEMENT, OR WITH psql's default autocommit --- NOT wrapped
-- in an explicit BEGIN/COMMIT. Postgres refuses to use an enum value that was added in the
-- same transaction, so the UPDATE ... SET "status" = 'Completed' below fails with
-- "unsafe use of new value of enum type" if the two ALTER TYPEs have not committed first.

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

-- Existing rows: the holder is whoever the gift was sent to.
UPDATE "MembershipGift" SET "holderId" = "recipientId" WHERE "holderId" IS NULL;

-- Rows fulfilled under the old design already had their whole value applied as a single
-- multi-month coupon, so they are Completed with nothing left to consume. Backfilling them
-- as Active would arm a second discount on top of a coupon that is still running.
UPDATE "MembershipGift"
SET "status" = 'Completed', "monthsConsumed" = "months", "monthsRemaining" = 0
WHERE "status" = 'Fulfilled';

ALTER TABLE "MembershipGift" ALTER COLUMN "holderId" SET NOT NULL;

ALTER TABLE "MembershipGift"
  ADD CONSTRAINT "MembershipGift_holderId_fkey"
  FOREIGN KEY ("holderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "MembershipGift_holderId_status_idx" ON "MembershipGift"("holderId", "status");
CREATE INDEX IF NOT EXISTS "MembershipGift_armedCouponId_idx" ON "MembershipGift"("armedCouponId");
