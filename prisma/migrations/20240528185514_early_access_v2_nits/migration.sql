
-- AlterTable
ALTER TABLE "ModelVersion" ALTER COLUMN "earlyAccessConfig" DROP NOT NULL,
ALTER COLUMN "earlyAccessConfig" DROP DEFAULT;
