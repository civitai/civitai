-- Profile folders. Apply before the code that reads these columns deploys.
-- Part 1 runs in a transaction; part 2 (CONCURRENTLY) must run on its own, outside one.

-- Part 1
SET lock_timeout = '5s';

-- Unused until the profileFolders flag lets the new code create a folder.
ALTER TYPE "CollectionMode" ADD VALUE IF NOT EXISTS 'Folder';

ALTER TABLE "CollectionItem" ADD COLUMN IF NOT EXISTS "showcasedAt" TIMESTAMP(3);

ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "folderRows" JSONB;

-- Part 2 (separately, not in a transaction)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "CollectionItem_showcase_idx"
  ON "CollectionItem" ("collectionId", "showcasedAt")
  WHERE "showcasedAt" IS NOT NULL;
