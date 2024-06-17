
-- CreateEnum
CREATE TYPE "CsamReportType" AS ENUM ('Image', 'TrainingData');

-- AlterTable
ALTER TABLE "CsamReport" ADD COLUMN     "type" "CsamReportType" NOT NULL DEFAULT 'Image';
