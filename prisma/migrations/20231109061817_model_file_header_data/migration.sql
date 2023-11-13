-- AlterEnum
ALTER TYPE "ModelHashType" ADD VALUE 'AutoV3';

-- AlterTable
ALTER TABLE "ModelFile" ADD COLUMN     "headerData" JSONB;
