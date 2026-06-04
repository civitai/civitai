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
  COLUMN "threadId" INTEGER;

-- CreateTable
CREATE TABLE "Thread" (
  "id" SERIAL NOT NULL,
  "locked" BOOLEAN NOT NULL DEFAULT false,
  "questionId" INTEGER,
  "answerId" INTEGER,
  "imageId" INTEGER,
  CONSTRAINT "Thread_pkey" PRIMARY KEY ("id")
);

-- Create threads from existing many-to-manys
INSERT INTO "Thread"("answerId") SELECT DISTINCT "answerId" FROM "AnswerComment";
INSERT INTO "Thread"("questionId") SELECT DISTINCT "questionId" FROM "QuestionComment";
INSERT INTO "Thread"("imageId") SELECT DISTINCT "imageId" FROM "ImageComment";

-- Migrate ImageComment to Thread
UPDATE "CommentV2" c
SET "threadId" = t.id
FROM "AnswerComment" ac
JOIN "Thread" t ON t."answerId" = ac."answerId"
WHERE c.id = ac."commentId";

-- DropTable
DROP TABLE "AnswerComment";

-- Migrate ImageComment to Thread
UPDATE "CommentV2" c
SET "threadId" = t.id
FROM "ImageComment" ac
JOIN "Thread" t ON t."imageId" = ac."imageId"
WHERE c.id = ac."commentId";

-- DropTable
DROP TABLE "ImageComment";

-- Migrate QuestionComment to Thread
UPDATE "CommentV2" c
SET "threadId" = t.id
FROM "QuestionComment" ac
JOIN "Thread" t ON t."questionId" = ac."questionId"
WHERE c.id = ac."commentId";

-- DropTable
DROP TABLE "QuestionComment";

-- Add NOT NULL constraint to threadId
DELETE FROM "CommentV2" WHERE "threadId" IS NULL;
ALTER TABLE "CommentV2" ALTER COLUMN "threadId" SET NOT NULL;

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