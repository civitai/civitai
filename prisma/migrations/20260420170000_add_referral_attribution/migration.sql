-- CreateTable
CREATE TABLE "ReferralAttribution" (
    "id" SERIAL NOT NULL,
    "referralCodeId" INTEGER NOT NULL,
    "refereeId" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "sourceEventId" TEXT,
    "tier" TEXT,
    "amount" INTEGER,
    "paymentProvider" TEXT,
    "stripePaymentIntentId" TEXT,
    "stripeInvoiceId" TEXT,
    "stripeChargeId" TEXT,
    "paymentMethodFingerprint" TEXT,
    "ipAddress" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReferralAttribution_referralCodeId_createdAt_idx" ON "ReferralAttribution"("referralCodeId", "createdAt");

-- CreateIndex
CREATE INDEX "ReferralAttribution_refereeId_idx" ON "ReferralAttribution"("refereeId");

-- CreateIndex
CREATE INDEX "ReferralAttribution_paymentMethodFingerprint_idx" ON "ReferralAttribution"("paymentMethodFingerprint");

-- CreateIndex
CREATE INDEX "ReferralAttribution_ipAddress_idx" ON "ReferralAttribution"("ipAddress");

-- CreateIndex
CREATE INDEX "ReferralAttribution_stripePaymentIntentId_idx" ON "ReferralAttribution"("stripePaymentIntentId");

-- AddForeignKey
ALTER TABLE "ReferralAttribution"
  ADD CONSTRAINT "ReferralAttribution_referralCodeId_fkey"
  FOREIGN KEY ("referralCodeId") REFERENCES "UserReferralCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralAttribution"
  ADD CONSTRAINT "ReferralAttribution_refereeId_fkey"
  FOREIGN KEY ("refereeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
