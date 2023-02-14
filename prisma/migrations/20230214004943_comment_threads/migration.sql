/*
 Warnings:
 
 TODO.Justin - resolve warnings
 - You are about to drop the column `locked` on the `CommentV2` table. All the data in the column will be lost.
 - You are about to drop the column `parentId` on the `CommentV2` table. All the data in the column will be lost.
 - You are about to drop the `AnswerComment` table. If the table is not empty, all the data it contains will be lost.
 - You are about to drop the `ImageComment` table. If the table is not empty, all the data it contains will be lost.
 - You are about to drop the `QuestionComment` table. If the table is not empty, all the data it contains will be lost.
 - Added the required column `threadId` to the `CommentV2` table without a default value. This is not possible if the table is not empty.
 
 */
-- DropForeignKey
ALTER TABLE
  "AnswerComment" DROP CONSTRAINT "AnswerComment_answerId_fkey";

-- DropForeignKey
ALTER TABLE
  "AnswerComment" DROP CONSTRAINT "AnswerComment_commentId_fkey";

-- DropForeignKey
ALTER TABLE
  "CommentV2" DROP CONSTRAINT "CommentV2_parentId_fkey";

-- DropForeignKey
ALTER TABLE
  "ImageComment" DROP CONSTRAINT "ImageComment_commentId_fkey";

-- DropForeignKey
ALTER TABLE
  "ImageComment" DROP CONSTRAINT "ImageComment_imageId_fkey";

-- DropForeignKey
ALTER TABLE
  "QuestionComment" DROP CONSTRAINT "QuestionComment_commentId_fkey";

-- DropForeignKey
ALTER TABLE
  "QuestionComment" DROP CONSTRAINT "QuestionComment_questionId_fkey";

-- AlterTable
ALTER TABLE
  "CommentV2" DROP COLUMN "locked",
  DROP COLUMN "parentId",
ADD
  COLUMN "threadId" INTEGER NOT NULL;

-- DropTable
DROP TABLE "AnswerComment";

-- DropTable
DROP TABLE "ImageComment";

-- DropTable
DROP TABLE "QuestionComment";

-- CreateTable
CREATE TABLE "Thread" (
  "id" SERIAL NOT NULL,
  "locked" BOOLEAN NOT NULL DEFAULT false,
  "questionId" INTEGER,
  "answerId" INTEGER,
  "imageId" INTEGER,
  CONSTRAINT "Thread_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Thread_questionId_key" ON "Thread"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "Thread_answerId_key" ON "Thread"("answerId");

-- CreateIndex
CREATE UNIQUE INDEX "Thread_imageId_key" ON "Thread"("imageId");

-- AddForeignKey
ALTER TABLE
  "CommentV2"
ADD
  CONSTRAINT "CommentV2_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE
  "Thread"
ADD
  CONSTRAINT "Thread_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE
SET
  NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE
  "Thread"
ADD
  CONSTRAINT "Thread_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "Answer"("id") ON DELETE
SET
  NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE
  "Thread"
ADD
  CONSTRAINT "Thread_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE
SET
  NULL ON UPDATE CASCADE;