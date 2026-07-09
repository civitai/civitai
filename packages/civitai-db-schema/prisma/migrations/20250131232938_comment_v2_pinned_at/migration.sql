
-- AlterTable
ALTER TABLE "CommentV2" ADD COLUMN     "pinnedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Thread_rootThreadId_idx" ON "Thread" USING HASH ("rootThreadId");
