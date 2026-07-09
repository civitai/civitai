-- AlterEnum
ALTER TYPE "ModelType" ADD VALUE 'AestheticGradient';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UserActivityType" ADD VALUE 'ReportModelTOSViolation';
ALTER TYPE "UserActivityType" ADD VALUE 'ReportModelNSFW';
ALTER TYPE "UserActivityType" ADD VALUE 'ReportReviewTOSViolation';
ALTER TYPE "UserActivityType" ADD VALUE 'ReportReviewNSFW';

-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "tosViolation" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "tosViolation" BOOLEAN NOT NULL DEFAULT false;
