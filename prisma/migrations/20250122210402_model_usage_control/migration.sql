-- CreateEnum
CREATE TYPE "ModelUsageControl" AS ENUM ('Download', 'Generation', 'InternalGeneration');

-- AlterTable
ALTER TABLE "ModelVersion" ADD COLUMN     "usageControl" "ModelUsageControl" NOT NULL DEFAULT 'Download';
 