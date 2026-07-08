BEGIN;
CREATE TYPE "OnboardingStep" AS ENUM ('Moderation', 'Buzz');
ALTER TABLE "User" ADD COLUMN "onboardingSteps" "OnboardingStep"[];
COMMIT;

BEGIN;
UPDATE "User" SET "onboardingSteps" = CASE
  WHEN onboarded = false THEN ARRAY['Moderation', 'Buzz']::"OnboardingStep"[]
  WHEN onboarded = true THEN ARRAY['Buzz']::"OnboardingStep"[]
END;
COMMIT;

ALTER TABLE "User" DROP COLUMN "onboarded";
