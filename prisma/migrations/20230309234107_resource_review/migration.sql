/*
  Warnings:

  - You are about to drop the `ReviewV2` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[reviewId]` on the table `Thread` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "ReviewV2" DROP CONSTRAINT "ReviewV2_modelVersionId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewV2" DROP CONSTRAINT "ReviewV2_threadId_fkey";

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "reviewId" INTEGER;

-- DropTable
DROP TABLE "ReviewV2";

-- CreateTable
CREATE TABLE "ResourceReview" (
    "id" SERIAL NOT NULL,
    "modelVersionId" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "details" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,

    CONSTRAINT "ResourceReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Thread_reviewId_key" ON "Thread"("reviewId");

-- AddForeignKey
ALTER TABLE "ResourceReview" ADD CONSTRAINT "ResourceReview_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceReview" ADD CONSTRAINT "ResourceReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "ResourceReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;
