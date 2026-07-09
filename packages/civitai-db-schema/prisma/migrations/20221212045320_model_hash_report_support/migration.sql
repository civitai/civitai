-- AlterEnum
ALTER TYPE "UserActivityType" ADD VALUE 'HashReport';

-- AlterTable
ALTER TABLE "Image" ADD COLUMN     "tosViolation" BOOLEAN NOT NULL DEFAULT false;
