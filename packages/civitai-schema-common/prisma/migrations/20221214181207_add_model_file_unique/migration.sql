/*
  Warnings:

  - A unique constraint covering the columns `[modelVersionId,type,format]` on the table `ModelFile` will be added. If there are existing duplicate values, this will fail.
  - Made the column `format` on table `ModelFile` required. This step will fail if there are existing NULL values in that column.

*/

-- Add Other FileFormat
UPDATE "ModelFile" SET "format" = 'Other' WHERE "format" IS NULL;

-- AlterTable
ALTER TABLE "ModelFile" ALTER COLUMN "format" SET NOT NULL,
ALTER COLUMN "format" SET DEFAULT 'Other';

-- CreateIndex
CREATE UNIQUE INDEX "ModelFile_modelVersionId_type_format_key" ON "ModelFile"("modelVersionId", "type", "format");
