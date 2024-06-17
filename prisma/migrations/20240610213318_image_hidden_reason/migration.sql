-- CreateEnum
CREATE TYPE "HiddenType" AS ENUM ('System', 'MissingMetadata');

-- AlterTable
ALTER TABLE "Image" ADD COLUMN     "hidden" "HiddenType";
