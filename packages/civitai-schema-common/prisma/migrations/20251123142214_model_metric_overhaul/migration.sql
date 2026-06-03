-- ModelMetric Overhaul Migration
-- This migration restructures ModelMetric to:
-- 1. Remove timeframe (now single row per model instead of one per timeframe)
-- 2. Remove unused fields: rating, ratingCount, favoriteCount
-- 3. Add denormalized model metadata for efficient filtering: poi, minor, nsfwLevel, userId, lastVersionAt, status, availability

-- Step 1: Add new columns with defaults
ALTER TABLE "ModelMetric" ADD COLUMN IF NOT EXISTS "poi" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ModelMetric" ADD COLUMN IF NOT EXISTS "minor" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ModelMetric" ADD COLUMN IF NOT EXISTS "nsfwLevel" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ModelMetric" ADD COLUMN IF NOT EXISTS "mode" "ModelModifier";
ALTER TABLE "ModelMetric" ADD COLUMN IF NOT EXISTS "userId" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ModelMetric" ADD COLUMN IF NOT EXISTS "lastVersionAt" TIMESTAMP(3);
ALTER TABLE "ModelMetric" ADD COLUMN IF NOT EXISTS "status" "ModelStatus" NOT NULL DEFAULT 'Draft';
ALTER TABLE "ModelMetric" ADD COLUMN IF NOT EXISTS "availability" "Availability" NOT NULL DEFAULT 'Public';

-- Step 2: Populate new columns from Model table (for AllTime rows only, which we'll keep)
UPDATE "ModelMetric" mm
SET
  "poi" = m."poi",
  "minor" = m."minor",
  "nsfwLevel" = m."nsfwLevel",
  "userId" = m."userId",
  "lastVersionAt" = m."lastVersionAt",
  "status" = m."status",
  "availability" = m."availability"
  "mode" = m."mode"
FROM "Model" m
WHERE mm."modelId" = m."id"
  AND mm."timeframe" = 'AllTime';

-- Step 3: Delete non-AllTime rows (we're consolidating to single row per model)
DELETE FROM "ModelMetric" WHERE "timeframe" != 'AllTime';

-- Step 4: Drop the old primary key constraint
ALTER TABLE "ModelMetric" DROP CONSTRAINT IF EXISTS "ModelMetric_pkey";

-- Step 5: Drop unused columns
ALTER TABLE "ModelMetric" DROP COLUMN IF EXISTS "timeframe";
ALTER TABLE "ModelMetric" DROP COLUMN IF EXISTS "rating";
ALTER TABLE "ModelMetric" DROP COLUMN IF EXISTS "ratingCount";
ALTER TABLE "ModelMetric" DROP COLUMN IF EXISTS "favoriteCount";

-- Step 6: Create new primary key on modelId only
ALTER TABLE "ModelMetric" ADD PRIMARY KEY ("modelId");

-- Step 7: Drop old indexes that referenced timeframe
DROP INDEX IF EXISTS "ModelMetric_collectedCount";
DROP INDEX IF EXISTS "ModelMetric_commentCount";
DROP INDEX IF EXISTS "ModelMetric_downloadCount";
DROP INDEX IF EXISTS "ModelMetric_imageCount";
DROP INDEX IF EXISTS "ModelMetric_thumbsUpCount";
DROP INDEX IF EXISTS "ModelMetric_tippedAmountCount";

-- Step 8: Create new indexes for common filter/sort operations
CREATE INDEX feed_highest_rated
ON "ModelMetric" (
    "thumbsUpCount" DESC,
    "downloadCount" DESC,
    "modelId"
) INCLUDE (
		"status",
		"availability",
		"mode",
		"nsfwLevel",
    "thumbsDownCount",
    "commentCount",
    "collectedCount",
    "tippedAmountCount",
    "poi",
    "minor",
    "userId"
);

CREATE INDEX feed_most_downloaded
ON "ModelMetric" (
    "downloadCount" DESC,
    "thumbsUpCount" DESC,
    "modelId"
) INCLUDE (
		"status",
		"availability",
		"mode",
		"nsfwLevel",
    "thumbsDownCount",
    "commentCount",
    "collectedCount",
    "tippedAmountCount",
    "poi",
    "minor",
    "userId"
);

CREATE INDEX feed_most_discussed
ON "ModelMetric" (
    "commentCount" DESC,
    "thumbsUpCount" DESC,
    "modelId"
) INCLUDE (
		"status",
		"availability",
		"mode",
		"nsfwLevel",
    "thumbsDownCount",
    "downloadCount",
    "collectedCount",
    "tippedAmountCount",
    "poi",
    "minor",
    "userId"
);

CREATE INDEX feed_most_collected
ON "ModelMetric" (
    "collectedCount" DESC,
    "thumbsUpCount" DESC,
    "modelId"
) INCLUDE (
	  "status",
		"availability",
		"mode",
		"nsfwLevel",
    "thumbsDownCount",
    "downloadCount",
    "commentCount",
    "tippedAmountCount",
    "poi",
    "minor",
    "userId"
);


CREATE INDEX feed_newest
ON "ModelMetric" (
    "lastVersionAt" DESC NULLS LAST,
    "modelId" DESC
) INCLUDE (
		"status",
    "availability",
		"mode",
    "nsfwLevel",
    "downloadCount",
		"thumbsUpCount",
    "thumbsDownCount",
    "commentCount",
    "collectedCount",
    "tippedAmountCount",
    "poi",
    "minor",
    "userId"
);

CREATE INDEX feed_oldest
ON "ModelMetric" (
    "lastVersionAt" ASC,
    "modelId"
) INCLUDE (
		"status",
    "availability",
		"mode",
    "nsfwLevel",
    "downloadCount",
		"thumbsUpCount",
    "thumbsDownCount",
    "commentCount",
    "collectedCount",
    "tippedAmountCount",
    "poi",
    "minor",
    "userId"
);
