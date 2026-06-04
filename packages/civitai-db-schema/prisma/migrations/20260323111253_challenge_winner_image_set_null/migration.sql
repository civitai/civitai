-- Make imageId nullable so winner records survive image deletion (cooldown enforcement)
ALTER TABLE "ChallengeWinner" ALTER COLUMN "imageId" DROP NOT NULL;

-- Replace CASCADE with SET NULL to preserve winner history when images are deleted
ALTER TABLE "ChallengeWinner" DROP CONSTRAINT "ChallengeWinner_imageId_fkey";
ALTER TABLE "ChallengeWinner" ADD CONSTRAINT "ChallengeWinner_imageId_fkey"
  FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;
