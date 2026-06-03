-- AlterTable
ALTER TABLE "User" ALTER COLUMN "onboardingSteps" SET DEFAULT ARRAY['Moderation', 'Buzz']::"OnboardingStep"[];

-- AlterTable
ALTER TABLE "UserReferralCode" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
