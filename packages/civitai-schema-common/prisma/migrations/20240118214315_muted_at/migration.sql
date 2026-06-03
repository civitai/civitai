-- Step 1: Add the mutedAt column
ALTER TABLE "User"
ADD COLUMN "mutedAt" timestamp(3);

-- Step 2: Populate the mutedAt column
-- Assuming you want to set it to the current timestamp for users who are currently muted
UPDATE "User" u
SET "mutedAt" = CASE
    WHEN muted = TRUE THEN u."createdAt"
    ELSE NULL
END;

-- Step 3: Drop the original muted column
ALTER TABLE "User"
DROP COLUMN muted;

-- Step 4: Add a computed muted column
ALTER TABLE "User"
ADD COLUMN muted boolean GENERATED ALWAYS AS ("mutedAt" IS NOT NULL) STORED;
