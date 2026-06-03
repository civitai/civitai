-- AlterTable: Add new prompt columns and sourceCollectionId to ChallengeJudge
ALTER TABLE "ChallengeJudge" ADD COLUMN "collectionPrompt" TEXT;
ALTER TABLE "ChallengeJudge" ADD COLUMN "contentPrompt" TEXT;
ALTER TABLE "ChallengeJudge" ADD COLUMN "sourceCollectionId" INTEGER;

-- DropIndex: Remove unique constraint on userId (allow multiple judge configs per user)
DROP INDEX IF EXISTS "ChallengeJudge_userId_key";

-- CreateIndex: Add non-unique index on userId for lookups
CREATE INDEX IF NOT EXISTS "ChallengeJudge_userId_idx" ON "ChallengeJudge"("userId");
