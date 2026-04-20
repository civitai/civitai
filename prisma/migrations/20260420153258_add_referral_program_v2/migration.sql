-- CreateEnum
CREATE TYPE "ReferralRewardStatus" AS ENUM ('Pending', 'Settled', 'Redeemed', 'Expired', 'Revoked');

-- CreateEnum
CREATE TYPE "ReferralRewardKind" AS ENUM ('MembershipToken', 'BuzzKickback', 'MilestoneBonus', 'RefereeBonus');

-- AlterTable
ALTER TABLE "UserReferral"
  ADD COLUMN "firstPaidAt" TIMESTAMP(3),
  ADD COLUMN "paidMonthCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ReferralReward" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "refereeId" INTEGER,
    "kind" "ReferralRewardKind" NOT NULL,
    "status" "ReferralRewardStatus" NOT NULL DEFAULT 'Pending',
    "tokenAmount" INTEGER NOT NULL DEFAULT 0,
    "buzzAmount" INTEGER NOT NULL DEFAULT 0,
    "tierGranted" TEXT,
    "sourceEventId" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "ReferralReward_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralReward_kind_sourceEventId_key" ON "ReferralReward"("kind", "sourceEventId");

-- CreateIndex
CREATE INDEX "ReferralReward_userId_status_idx" ON "ReferralReward"("userId", "status");

-- CreateIndex
CREATE INDEX "ReferralReward_userId_kind_idx" ON "ReferralReward"("userId", "kind");

-- CreateIndex
CREATE INDEX "ReferralReward_refereeId_idx" ON "ReferralReward"("refereeId");

-- CreateIndex
CREATE INDEX "ReferralReward_expiresAt_idx" ON "ReferralReward"("expiresAt");

-- CreateIndex
CREATE INDEX "ReferralReward_status_settledAt_idx" ON "ReferralReward"("status", "settledAt");

-- AddForeignKey
ALTER TABLE "ReferralReward"
  ADD CONSTRAINT "ReferralReward_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralReward"
  ADD CONSTRAINT "ReferralReward_refereeId_fkey"
  FOREIGN KEY ("refereeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ReferralMilestone" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "threshold" INTEGER NOT NULL,
    "bonusAmount" INTEGER NOT NULL,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralMilestone_userId_threshold_key" ON "ReferralMilestone"("userId", "threshold");

-- AddForeignKey
ALTER TABLE "ReferralMilestone"
  ADD CONSTRAINT "ReferralMilestone_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ReferralRedemption" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "tokensSpent" INTEGER NOT NULL,
    "tier" TEXT NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "subscriptionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReferralRedemption_userId_idx" ON "ReferralRedemption"("userId");

-- AddForeignKey
ALTER TABLE "ReferralRedemption"
  ADD CONSTRAINT "ReferralRedemption_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
