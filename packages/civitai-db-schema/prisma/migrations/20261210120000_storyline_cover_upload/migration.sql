-- Images uploaded through a storyline's Manage as its card cover or banner. Additive; no backfill
-- (no storyline has an uploaded cover before this ships). Apply BEFORE the release that reads it.
CREATE TABLE IF NOT EXISTS "StorylineCoverUpload" (
  "storylineId" INTEGER NOT NULL,
  "imageId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StorylineCoverUpload_pkey" PRIMARY KEY ("storylineId", "imageId")
);

CREATE INDEX IF NOT EXISTS "StorylineCoverUpload_imageId_idx" ON "StorylineCoverUpload"("imageId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StorylineCoverUpload_storylineId_fkey') THEN
    ALTER TABLE "StorylineCoverUpload" ADD CONSTRAINT "StorylineCoverUpload_storylineId_fkey"
      FOREIGN KEY ("storylineId") REFERENCES "Storyline"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StorylineCoverUpload_imageId_fkey') THEN
    ALTER TABLE "StorylineCoverUpload" ADD CONSTRAINT "StorylineCoverUpload_imageId_fkey"
      FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
