-- CreateEnum
CREATE TYPE "ModelStatus" AS ENUM ('Draft', 'Published', 'Unpublished');

-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "status" "ModelStatus" NOT NULL DEFAULT 'Draft';

-- AlterTable
ALTER TABLE "ModelFile" ADD COLUMN     "exists" BOOLEAN;

-- AlterTable
ALTER TABLE "ModelVersion" ADD COLUMN     "status" "ModelStatus" NOT NULL DEFAULT 'Draft';

UPDATE "Model" SET "status" = 'Published';
UPDATE "ModelVersion" SET "status" = 'Published';
