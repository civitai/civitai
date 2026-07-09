-- DropForeignKey
ALTER TABLE "ModelAssociations" DROP CONSTRAINT "ModelAssociations_toModelId_fkey";

-- AlterTable
ALTER TABLE "ModelAssociations" ALTER COLUMN "toModelId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "ModelAssociations" ADD CONSTRAINT "ModelAssociations_toModelId_fkey" FOREIGN KEY ("toModelId") REFERENCES "Model"("id") ON DELETE SET NULL ON UPDATE CASCADE;
