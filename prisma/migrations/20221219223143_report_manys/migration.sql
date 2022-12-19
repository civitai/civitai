/*
  Warnings:

  - The values [SecurityConcern] on the enum `ReportReason` will be removed. If these variants are still used in the database, this will fail.
  - The primary key for the `CommentReport` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `createdAt` on the `CommentReport` table. All the data in the column will be lost.
  - You are about to drop the column `id` on the `CommentReport` table. All the data in the column will be lost.
  - You are about to drop the column `reason` on the `CommentReport` table. All the data in the column will be lost.
  - You are about to drop the column `userId` on the `CommentReport` table. All the data in the column will be lost.
  - The primary key for the `ModelReport` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `createdAt` on the `ModelReport` table. All the data in the column will be lost.
  - You are about to drop the column `details` on the `ModelReport` table. All the data in the column will be lost.
  - You are about to drop the column `id` on the `ModelReport` table. All the data in the column will be lost.
  - You are about to drop the column `reason` on the `ModelReport` table. All the data in the column will be lost.
  - You are about to drop the column `reviewedAt` on the `ModelReport` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `ModelReport` table. All the data in the column will be lost.
  - You are about to drop the column `userId` on the `ModelReport` table. All the data in the column will be lost.
  - The primary key for the `ReviewReport` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `createdAt` on the `ReviewReport` table. All the data in the column will be lost.
  - You are about to drop the column `id` on the `ReviewReport` table. All the data in the column will be lost.
  - You are about to drop the column `reason` on the `ReviewReport` table. All the data in the column will be lost.
  - You are about to drop the column `userId` on the `ReviewReport` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[reportId]` on the table `CommentReport` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[reportId]` on the table `ModelReport` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[reportId]` on the table `ReviewReport` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `reportId` to the `CommentReport` table without a default value. This is not possible if the table is not empty.
  - Added the required column `reportId` to the `ModelReport` table without a default value. This is not possible if the table is not empty.
  - Added the required column `reportId` to the `ReviewReport` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "ReportReason_new" AS ENUM ('TOSViolation', 'NSFW', 'Ownership', 'AdminAttention', 'Claim');
ALTER TABLE "Report" ALTER COLUMN "reason" TYPE "ReportReason_new" USING ("reason"::text::"ReportReason_new");
ALTER TYPE "ReportReason" RENAME TO "ReportReason_old";
ALTER TYPE "ReportReason_new" RENAME TO "ReportReason";
DROP TYPE "ReportReason_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "CommentReport" DROP CONSTRAINT "CommentReport_commentId_fkey";

-- DropForeignKey
ALTER TABLE "CommentReport" DROP CONSTRAINT "CommentReport_userId_fkey";

-- DropForeignKey
ALTER TABLE "ModelReport" DROP CONSTRAINT "ModelReport_modelId_fkey";

-- DropForeignKey
ALTER TABLE "ModelReport" DROP CONSTRAINT "ModelReport_userId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewReport" DROP CONSTRAINT "ReviewReport_reviewId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewReport" DROP CONSTRAINT "ReviewReport_userId_fkey";

-- CreateTable
CREATE TABLE "Report" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "reason" "ReportReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "details" JSONB,
    "status" "ReportStatus" NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- Comment Report
INSERT INTO "Report" ("id", "userId", "reason", "createdAt", "details", "status")
SELECT "id", "userId", "reason", "createdAt", JSONB_BUILD_OBJECT('commentId', "commentId"), 'Valid'
FROM "CommentReport";

ALTER TABLE "CommentReport" DROP CONSTRAINT "CommentReport_pkey",
DROP COLUMN "createdAt",
DROP COLUMN "id",
DROP COLUMN "reason",
DROP COLUMN "userId",
ADD COLUMN     "reportId" INTEGER;

UPDATE "CommentReport" SET "reportId" = "Report"."id"
FROM "Report"
WHERE cast("Report".details->'commentId' as int) = "commentId";

ALTER TABLE "CommentReport"
ALTER COLUMN     "reportId" SET NOT NULL,
ADD CONSTRAINT "CommentReport_pkey" PRIMARY KEY ("reportId", "commentId");

-- Model Report
INSERT INTO "Report" ("id", "userId", "reason", "createdAt", "details", "status")
SELECT "id", "userId", "reason", "createdAt", "details" || JSONB_BUILD_OBJECT('modelId', "modelId"), "status"
FROM "ModelReport";

ALTER TABLE "ModelReport" DROP CONSTRAINT "ModelReport_pkey",
DROP COLUMN "createdAt",
DROP COLUMN "details",
DROP COLUMN "id",
DROP COLUMN "reason",
DROP COLUMN "reviewedAt",
DROP COLUMN "status",
DROP COLUMN "userId",
ADD COLUMN     "reportId" INTEGER;

UPDATE "ModelReport" SET "reportId" = "Report"."id"
FROM "Report"
WHERE cast("Report".details->'modelId' as int) = "modelId";

ALTER TABLE "ModelReport"
ALTER COLUMN     "reportId" SET NOT NULL,
ADD CONSTRAINT "ModelReport_pkey" PRIMARY KEY ("reportId", "modelId");

-- Review Report
INSERT INTO "Report" ("id", "userId", "reason", "createdAt", "details", "status")
SELECT "id", "userId", "reason", "createdAt", JSONB_BUILD_OBJECT('reviewId', "reviewId"), 'Valid'
FROM "ReviewReport";

ALTER TABLE "ReviewReport" DROP CONSTRAINT "ReviewReport_pkey",
DROP COLUMN "createdAt",
DROP COLUMN "id",
DROP COLUMN "reason",
DROP COLUMN "userId",
ADD COLUMN     "reportId" INTEGER,
ADD CONSTRAINT "ReviewReport_pkey" PRIMARY KEY ("reportId", "reviewId");

UPDATE "ReviewReport" SET "reportId" = "Report"."id"
FROM "Report"
WHERE cast("Report".details->'reviewId' as int) = "reviewId";

ALTER TABLE "ReviewReport"
ALTER COLUMN  "reportId" SET NOT NULL,
ADD CONSTRAINT "ReviewReport_pkey" PRIMARY KEY ("reportId", "reviewId");

-- CreateIndex
CREATE UNIQUE INDEX "CommentReport_reportId_key" ON "CommentReport"("reportId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelReport_reportId_key" ON "ModelReport"("reportId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewReport_reportId_key" ON "ReviewReport"("reportId");

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelReport" ADD CONSTRAINT "ModelReport_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelReport" ADD CONSTRAINT "ModelReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewReport" ADD CONSTRAINT "ReviewReport_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewReport" ADD CONSTRAINT "ReviewReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentReport" ADD CONSTRAINT "CommentReport_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentReport" ADD CONSTRAINT "CommentReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE RESTRICT ON UPDATE CASCADE;