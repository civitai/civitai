BEGIN;
ALTER TABLE "ChallengeEvent" ADD COLUMN "coverImageId" INTEGER;
ALTER TABLE "ChallengeEvent"
  ADD CONSTRAINT "ChallengeEvent_coverImageId_fkey"
  FOREIGN KEY ("coverImageId") REFERENCES "Image"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
COMMIT;
