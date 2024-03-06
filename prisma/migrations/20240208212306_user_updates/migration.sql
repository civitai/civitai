

-- AlterTable
ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS     "browsingLevel" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS     "onboarding" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "showNsfw" SET NOT NULL,
ALTER COLUMN "blurNsfw" SET NOT NULL,
ALTER COLUMN "muted" SET NOT NULL,
ALTER COLUMN "muted" SET DEFAULT false;


DELETE FROM "TagEngagement" WHERE "tagId" = ANY('{"113976","113474","113645","113644","113660","113975"}');

-- TODO.Briant - do this after pushing to prod
-- ALTER TABLE "User"
-- DROP COLUMN "onboardingSteps",
-- DROP COLUMN "tos",
