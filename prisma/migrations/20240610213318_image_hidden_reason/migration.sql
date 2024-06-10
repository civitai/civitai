-- CreateEnum
CREATE TYPE "HiddenType" AS ENUM ('System', 'MissingMetadata');

-- AlterTable
ALTER TABLE "Image" ADD COLUMN     "hidden" "HiddenType";

-- UPDATE "Image" SET hidden = 'MissingMeta' WHERE meta->'prompt' IS NULL AND hidden IS NULL;
