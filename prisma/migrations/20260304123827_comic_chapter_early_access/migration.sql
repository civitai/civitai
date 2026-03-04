-- Add autoincrement id column for EntityAccess integration
ALTER TABLE "ComicChapter" ADD COLUMN "id" SERIAL;
ALTER TABLE "ComicChapter" ADD CONSTRAINT "ComicChapter_id_key" UNIQUE ("id");

-- Add early access fields
ALTER TABLE "ComicChapter" ADD COLUMN "availability" "Availability" NOT NULL DEFAULT 'Public';
ALTER TABLE "ComicChapter" ADD COLUMN "earlyAccessConfig" JSONB;
ALTER TABLE "ComicChapter" ADD COLUMN "earlyAccessEndsAt" TIMESTAMP(3);

-- Add moderation fields
ALTER TABLE "ComicProject" ADD COLUMN "tosViolation" BOOLEAN NOT NULL DEFAULT false;
