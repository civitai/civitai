-- Music: a song's cover and genre in their own table, replacing "Image".metadata.coverImageId and
-- "Image".metadata.genre.
--
-- MANUAL APPLY: a human applies this per environment BEFORE the code that writes the table ships.
-- Then, on any environment that holds song data, run backfill.sql (this directory) right after it,
-- dry run first. It is not in this file: where there are no songs it would only scan "Image".
-- Additive: one new table, no change to "Image". The foreign keys briefly lock "Image"; the lock
-- timeout makes a busy table fail fast so the statement can be retried. Idempotent.
SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "Track" (
  "imageId"      INTEGER NOT NULL,
  "coverImageId" INTEGER,
  "genre"        TEXT,
  CONSTRAINT "Track_pkey" PRIMARY KEY ("imageId")
);

-- One song per cover; also what the cover foreign key's ON DELETE reads.
CREATE UNIQUE INDEX IF NOT EXISTS "Track_coverImageId_key" ON "Track"("coverImageId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Track_imageId_fkey') THEN
    ALTER TABLE "Track" ADD CONSTRAINT "Track_imageId_fkey"
      FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Track_coverImageId_fkey') THEN
    ALTER TABLE "Track" ADD CONSTRAINT "Track_coverImageId_fkey"
      FOREIGN KEY ("coverImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
