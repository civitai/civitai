/*
  Warnings:

  - Changed the type of `type` on the `ModelFile` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "ModelFile" ADD COLUMN "type_s" TEXT;

UPDATE "ModelFile" SET "type_s" = 'Pruned Model' WHERE "type" = 'PrunedModel';
UPDATE "ModelFile" SET "type_s" = 'Training Data' WHERE "type" = 'TrainingData';
UPDATE "ModelFile" SET "type_s" = "type" WHERE "type" NOT IN ('TrainingData', 'PrunedModel');

ALTER TABLE "ModelFile" DROP COLUMN "type";
-- DropEnum
DROP TYPE "ModelFileType";

ALTER TABLE "ModelFile" RENAME COLUMN "type_s" TO "type";
ALTER TABLE "ModelFile" ALTER COLUMN "type" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ModelFile_modelVersionId_type_format_key" ON "ModelFile"("modelVersionId", "type", "format");
