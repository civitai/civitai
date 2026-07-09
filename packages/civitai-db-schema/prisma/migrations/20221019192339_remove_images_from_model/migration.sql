/*
  Warnings:

  - The primary key for the `ImagesOnModels` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `modelId` on the `ImagesOnModels` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "ImagesOnModels" DROP CONSTRAINT "ImagesOnModels_modelId_fkey";

-- DropForeignKey
ALTER TABLE "ImagesOnModels" DROP CONSTRAINT "ImagesOnModels_modelVersionId_fkey";

-- AlterTable
ALTER TABLE "ImagesOnModels" DROP CONSTRAINT "ImagesOnModels_pkey",
DROP COLUMN "modelId",
ADD CONSTRAINT "ImagesOnModels_pkey" PRIMARY KEY ("imageId", "modelVersionId");

-- AddForeignKey
ALTER TABLE "ImagesOnModels" ADD CONSTRAINT "ImagesOnModels_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
