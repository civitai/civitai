

-- AlterTable
ALTER TABLE "User"
DROP COLUMN "onboardingSteps",
DROP COLUMN "showNsfw",
DROP COLUMN "tos",
ADD COLUMN     "browsingLevel" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "onboarding" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "muted" SET NOT NULL,
ALTER COLUMN "muted" SET DEFAULT false;


