-- Create ChallengeReviewCostType enum
CREATE TYPE "ChallengeReviewCostType" AS ENUM ('None', 'PerEntry', 'Flat');

-- Add reviewCostType column (default None)
ALTER TABLE "Challenge" ADD COLUMN "reviewCostType" "ChallengeReviewCostType" NOT NULL DEFAULT 'None';

-- Add reviewCost column if not exists (safe for fresh installs)
ALTER TABLE "Challenge" ADD COLUMN IF NOT EXISTS "reviewCost" INTEGER NOT NULL DEFAULT 0;

-- Migrate existing data: infer reviewCostType from old reviewCost/reviewFlatCost columns
-- If reviewFlatCost > 0, it's Flat (move the value into reviewCost)
-- If reviewCost > 0 (and reviewFlatCost = 0), it's PerEntry (reviewCost already correct)
UPDATE "Challenge"
SET "reviewCostType" = 'Flat',
    "reviewCost" = "reviewFlatCost"
WHERE "reviewFlatCost" > 0;

UPDATE "Challenge"
SET "reviewCostType" = 'PerEntry'
WHERE "reviewCost" > 0 AND "reviewFlatCost" = 0;

-- Drop the old reviewFlatCost column
ALTER TABLE "Challenge" DROP COLUMN IF EXISTS "reviewFlatCost";
