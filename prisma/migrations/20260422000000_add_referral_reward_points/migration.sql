-- Add per-row Referral Points snapshot to ReferralReward.
-- For BuzzKickback / MilestoneBonus this equals buzzAmount (1pt per blue buzz).
-- For MembershipToken this equals constants.referrals.pointsPerTierMonth[tier]
-- at the time of the paid month so re-tuning the constants doesn't
-- retroactively re-evaluate historical rewards (no phantom milestones).
ALTER TABLE "ReferralReward" ADD COLUMN "points" INTEGER NOT NULL DEFAULT 0;

-- Backfill existing rows. BuzzKickback/MilestoneBonus get 1pt per blue buzz.
UPDATE "ReferralReward"
SET "points" = "buzzAmount"
WHERE kind IN ('BuzzKickback', 'MilestoneBonus');

-- MembershipToken rows get the tier-canonical points value as it stands today.
-- These constants match constants.referrals.pointsPerTierMonth.
UPDATE "ReferralReward"
SET "points" = CASE "tierGranted"
  WHEN 'bronze' THEN 1000
  WHEN 'silver' THEN 2500
  WHEN 'gold'   THEN 5000
  ELSE 0
END
WHERE kind = 'MembershipToken';
