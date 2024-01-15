/*
  Warnings:

  - You are about to drop the `ArticleRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ImageRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ModelRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ModelVersionRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PostRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TagRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserRank` table. If the table is not empty, all the data it contains will be lost.
  - Made the column `userId` on table `NotificationViewed` required. This step will fail if there are existing NULL values in that column.

*/
-- DropIndex
DROP INDEX "Notification_userId_idx";

-- DropIndex
DROP INDEX "NotificationViewed_userId";

-- AlterTable
ALTER TABLE "NotificationViewed" ALTER COLUMN "userId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "parentThreadId" INTEGER,
ADD COLUMN     "rootThreadId" INTEGER;

-- DropTable
DROP TABLE "ArticleRank";

-- DropTable
DROP TABLE "ImageRank";

-- DropTable
DROP TABLE "ModelRank";

-- DropTable
DROP TABLE "ModelVersionRank";

-- DropTable
DROP TABLE "PostRank";

-- DropTable
DROP TABLE "TagRank";

-- DropTable
DROP TABLE "UserRank";

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_parentThreadId_fkey" FOREIGN KEY ("parentThreadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_rootThreadId_fkey" FOREIGN KEY ("rootThreadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
