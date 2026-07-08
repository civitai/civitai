/*
  Warnings:

  - The values [ReportModelTOSViolation,ReportModelNSFW,ReportReviewTOSViolation,ReportReviewNSFW] on the enum `UserActivityType` will be removed. If these variants are still used in the database, this will fail.

*/
-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('TOSViolation', 'NSFW');

-- AlterEnum
BEGIN;
CREATE TYPE "UserActivityType_new" AS ENUM ('ModelDownload', 'TrainingDataDownload');
ALTER TABLE "UserActivity" ALTER COLUMN "activity" TYPE "UserActivityType_new" USING ("activity"::text::"UserActivityType_new");
ALTER TYPE "UserActivityType" RENAME TO "UserActivityType_old";
ALTER TYPE "UserActivityType_new" RENAME TO "UserActivityType";
DROP TYPE "UserActivityType_old";
COMMIT;

-- CreateTable
CREATE TABLE "ModelReport" (
    "id" SERIAL NOT NULL,
    "modelId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "reason" "ReportReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewReport" (
    "id" SERIAL NOT NULL,
    "reviewId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "reason" "ReportReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewReport_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ModelReport" ADD CONSTRAINT "ModelReport_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelReport" ADD CONSTRAINT "ModelReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewReport" ADD CONSTRAINT "ReviewReport_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewReport" ADD CONSTRAINT "ReviewReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
