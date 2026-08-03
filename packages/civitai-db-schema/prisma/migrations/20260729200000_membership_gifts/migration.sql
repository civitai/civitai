-- Gift memberships (GREEN/Stripe): audit + idempotent-fulfillment table.
-- Applied manually (we do NOT use prisma migrate deploy).

CREATE TYPE "MembershipGiftStatus" AS ENUM ('Pending', 'Fulfilled', 'Failed', 'Refunded', 'Revoked');

CREATE TABLE "MembershipGift" (
    "id" TEXT NOT NULL,
    "gifterId" INTEGER NOT NULL,
    "recipientId" INTEGER NOT NULL,
    "tier" TEXT NOT NULL,
    "months" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "MembershipGiftStatus" NOT NULL DEFAULT 'Pending',
    "message" TEXT,
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "stripeCheckoutSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "stripeCouponId" TEXT,
    "stripeSubscriptionId" TEXT,
    "fulfilledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MembershipGift_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MembershipGift_stripeCheckoutSessionId_key" ON "MembershipGift"("stripeCheckoutSessionId");
CREATE UNIQUE INDEX "MembershipGift_stripePaymentIntentId_key" ON "MembershipGift"("stripePaymentIntentId");
CREATE INDEX "MembershipGift_recipientId_idx" ON "MembershipGift"("recipientId");
CREATE INDEX "MembershipGift_gifterId_idx" ON "MembershipGift"("gifterId");

ALTER TABLE "MembershipGift" ADD CONSTRAINT "MembershipGift_gifterId_fkey" FOREIGN KEY ("gifterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MembershipGift" ADD CONSTRAINT "MembershipGift_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
