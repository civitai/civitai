-- AlterTable: Make ChallengeEvent.createdById nullable and change FK to SET NULL
-- This preserves events when a moderator account is deleted, avoiding disruption to active events.
ALTER TABLE "ChallengeEvent" DROP CONSTRAINT "ChallengeEvent_createdById_fkey";
ALTER TABLE "ChallengeEvent" ALTER COLUMN "createdById" DROP NOT NULL;
ALTER TABLE "ChallengeEvent" ADD CONSTRAINT "ChallengeEvent_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
