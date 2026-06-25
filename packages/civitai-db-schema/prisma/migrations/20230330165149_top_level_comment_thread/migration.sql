/*
  Warnings:

  - A unique constraint covering the columns `[commentId]` on the table `Thread` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[modelId]` on the table `Thread` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "commentId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Thread_commentId_key" ON "Thread"("commentId");

-- CreateIndex
CREATE UNIQUE INDEX "Thread_modelId_key" ON "Thread"("modelId");

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "CommentV2"("id") ON DELETE SET NULL ON UPDATE CASCADE;
