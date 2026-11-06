-- Storylines: a post author's caption on one image of a chapter.
--
-- MANUAL APPLY: a human applies this per environment BEFORE the code that reads the table ships.
-- Additive: one new table. The foreign key briefly locks "Image"; the lock timeout makes a busy
-- table fail fast so the statement can be retried. Idempotent.
SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "ImageCaption" (
  "imageId"   INTEGER NOT NULL,
  "userId"    INTEGER NOT NULL,
  "content"   VARCHAR(500) NOT NULL,
  "refused"   BOOLEAN NOT NULL DEFAULT false,
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ImageCaption_pkey" PRIMARY KEY ("imageId")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ImageCaption_imageId_fkey') THEN
    ALTER TABLE "ImageCaption" ADD CONSTRAINT "ImageCaption_imageId_fkey"
      FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
