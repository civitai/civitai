/*
  Warnings:

  - A unique constraint covering the columns `[postId]` on the table `Thread` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Image" ADD COLUMN     "hideMeta" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "index" INTEGER,
ADD COLUMN     "scanned" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "modelVersionId" INTEGER,
ADD COLUMN     "scanned" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "postId" INTEGER;

-- CreateTable
CREATE TABLE "ReviewV2" (
    "id" SERIAL NOT NULL,
    "modelVersionId" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "details" TEXT NOT NULL,
    "threadId" INTEGER,

    CONSTRAINT "ReviewV2_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostReaction" (
    "id" SERIAL NOT NULL,
    "postId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "reaction" "ReviewReactions" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostReaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PostReaction_postId_userId_reaction_key" ON "PostReaction"("postId", "userId", "reaction");

-- CreateIndex
CREATE UNIQUE INDEX "Thread_postId_key" ON "Thread"("postId");

-- AddForeignKey
ALTER TABLE "ReviewV2" ADD CONSTRAINT "ReviewV2_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewV2" ADD CONSTRAINT "ReviewV2_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostReaction" ADD CONSTRAINT "PostReaction_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostReaction" ADD CONSTRAINT "PostReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
