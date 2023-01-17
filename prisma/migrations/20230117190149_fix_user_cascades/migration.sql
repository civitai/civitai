-- DropForeignKey
ALTER TABLE "AnswerVote" DROP CONSTRAINT "AnswerVote_answerId_fkey";

-- DropForeignKey
ALTER TABLE "AnswerVote" DROP CONSTRAINT "AnswerVote_userId_fkey";

-- DropForeignKey
ALTER TABLE "Report" DROP CONSTRAINT "Report_userId_fkey";

-- DropForeignKey
ALTER TABLE "TagEngagement" DROP CONSTRAINT "TagEngagement_tagId_fkey";

-- DropForeignKey
ALTER TABLE "TagEngagement" DROP CONSTRAINT "TagEngagement_userId_fkey";

-- DropForeignKey
ALTER TABLE "UserEngagement" DROP CONSTRAINT "UserEngagement_targetUserId_fkey";

-- DropForeignKey
ALTER TABLE "UserEngagement" DROP CONSTRAINT "UserEngagement_userId_fkey";

-- AddForeignKey
ALTER TABLE "UserEngagement" ADD CONSTRAINT "UserEngagement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserEngagement" ADD CONSTRAINT "UserEngagement_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnswerVote" ADD CONSTRAINT "AnswerVote_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "Answer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnswerVote" ADD CONSTRAINT "AnswerVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagEngagement" ADD CONSTRAINT "TagEngagement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagEngagement" ADD CONSTRAINT "TagEngagement_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
