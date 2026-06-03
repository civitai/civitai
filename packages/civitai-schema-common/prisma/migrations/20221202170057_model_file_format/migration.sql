-- CreateEnum
CREATE TYPE "ModelFileFormat" AS ENUM ('PickleTensor', 'SafeTensor');

-- AlterTable
ALTER TABLE "ModelFile" ADD COLUMN     "format" "ModelFileFormat";

UPDATE "ModelFile" SET "format" = 'PickleTensor' WHERE "type" = 'Model'