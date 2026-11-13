-- Music: a song's lyrics in their own table, replacing "Image".metadata.lyrics.
--
-- MANUAL APPLY: a human applies this per environment BEFORE the code that writes the table ships.
-- Additive: one new enum type and one new table. The foreign key briefly locks "Image"; the lock
-- timeout makes a busy table fail fast so the statement can be retried. Idempotent.
SET lock_timeout = '3s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TrackLyricsSource') THEN
    CREATE TYPE "TrackLyricsSource" AS ENUM ('generator', 'user', 'aligned', 'transcribed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "TrackLyrics" (
  "imageId"   INTEGER NOT NULL,
  "text"      TEXT NOT NULL,
  "lines"     JSONB NOT NULL,
  "source"    "TrackLyricsSource" NOT NULL,
  "language"  TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TrackLyrics_pkey" PRIMARY KEY ("imageId")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TrackLyrics_imageId_fkey') THEN
    ALTER TABLE "TrackLyrics" ADD CONSTRAINT "TrackLyrics_imageId_fkey"
      FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
