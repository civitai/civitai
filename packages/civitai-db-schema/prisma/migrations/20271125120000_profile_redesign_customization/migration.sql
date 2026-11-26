-- Profile redesign: page background, card colours (pageTheme), About text and pinned items, sidebar cosmetic.
-- Apply ALL of it before the code that uses these columns deploys. Without them, flag or not,
-- every profile save, moderator clear and archive, CSAM hold removal, profile scam scan and
-- personal-data export fails. Run the parts in order: part 1 in a transaction, parts 2-4 each on
-- their own.

-- Part 1
SET lock_timeout = '5s';

-- Added before the deploy, against the usual enum order: listings that query by every
-- CosmeticType value would send an unknown label to Postgres in between. No row carries it until
-- a moderator creates one, and none is created until this release is past its revert window
-- (a pre-release client cannot decode the label).
ALTER TYPE "CosmeticType" ADD VALUE IF NOT EXISTS 'SidebarBackground';

-- Nullable or a constant default: no table rewrite.
ALTER TABLE "UserProfile"
  ADD COLUMN IF NOT EXISTS "backgroundImageId" INTEGER,
  ADD COLUMN IF NOT EXISTS "sfwBackgroundImageId" INTEGER,
  ADD COLUMN IF NOT EXISTS "pageTheme" JSONB,
  ADD COLUMN IF NOT EXISTS "pinnedItems" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "about" TEXT;

-- Part 2 (separately, not in a transaction). Before the foreign keys: their SET NULL trigger
-- looks these columns up on every Image delete, which would scan UserProfile without an index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "UserProfile_backgroundImageId_idx" ON "UserProfile" ("backgroundImageId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "UserProfile_sfwBackgroundImageId_idx" ON "UserProfile" ("sfwBackgroundImageId");

-- Part 3 (separately, after part 2 and its indexes are valid).
-- NOT VALID: the new columns are all NULL, so there is nothing to check and no reason to scan.
SET lock_timeout = '5s';
DO $$ BEGIN
  ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_backgroundImageId_fkey"
    FOREIGN KEY ("backgroundImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_sfwBackgroundImageId_fkey"
    FOREIGN KEY ("sfwBackgroundImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Part 4 (separately, after part 3)
ALTER TABLE "UserProfile" VALIDATE CONSTRAINT "UserProfile_backgroundImageId_fkey";
ALTER TABLE "UserProfile" VALIDATE CONSTRAINT "UserProfile_sfwBackgroundImageId_fkey";
