-- Per-domain profile customization: optional SFW (civitai.com) overrides for the
-- cover image, announcement and bio. NULL means "inherit the mature value".
ALTER TABLE "UserProfile"
  ADD COLUMN IF NOT EXISTS "sfwCoverImageId" INTEGER,
  ADD COLUMN IF NOT EXISTS "sfwBio" TEXT,
  ADD COLUMN IF NOT EXISTS "sfwMessage" TEXT,
  ADD COLUMN IF NOT EXISTS "sfwMessageAddedAt" TIMESTAMP(3);

ALTER TABLE "UserProfile"
  ADD CONSTRAINT "UserProfile_sfwCoverImageId_fkey"
  FOREIGN KEY ("sfwCoverImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;
