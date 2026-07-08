-- Safe migration: Convert buzzTransactionId from TEXT to TEXT[]
-- This migration preserves existing data by:
-- 1. Creating a temporary array column
-- 2. Migrating existing non-null values into single-element arrays
-- 3. Dropping the old column
-- 4. Renaming the new column

BEGIN;

-- Step 1: Add temporary array column
ALTER TABLE "public"."BountyBenefactor"
  ADD COLUMN "buzzTransactionId_new" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Step 2: Migrate existing data
-- Convert non-null strings to single-element arrays
UPDATE "public"."BountyBenefactor"
  SET "buzzTransactionId_new" = ARRAY["buzzTransactionId"]
  WHERE "buzzTransactionId" IS NOT NULL;

-- Step 3: Drop old column
ALTER TABLE "public"."BountyBenefactor"
  DROP COLUMN "buzzTransactionId";

-- Step 4: Rename new column to original name
ALTER TABLE "public"."BountyBenefactor"
  RENAME COLUMN "buzzTransactionId_new" TO "buzzTransactionId";

COMMIT;
