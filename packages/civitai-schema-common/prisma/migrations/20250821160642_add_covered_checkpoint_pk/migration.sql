-- AlterTable
ALTER TABLE "public"."CoveredCheckpoint" ADD CONSTRAINT "CoveredCheckpoint_pkey" PRIMARY KEY ("model_id", "version_id");

-- DropIndex
DROP INDEX "public"."CoveredCheckpoint_modelVersion";
