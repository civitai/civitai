-- CreateEnum
CREATE TYPE "RewardsEligibility" AS ENUM ('Eligible', 'Ineligible', 'Protected');

-- AlterTable
ALTER TABLE "User"
ADD COLUMN     "eligibilityChangedAt" TIMESTAMP(3),
ADD COLUMN     "rewardsEligibility" "RewardsEligibility" NOT NULL DEFAULT 'Eligible';
