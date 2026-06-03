/*
  Warnings:

  - You are about to drop the column `type` on the `ImagesOnModels` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "ImagesOnModels" DROP COLUMN "type",
ADD COLUMN     "index" INTEGER;

-- AlterTable
ALTER TABLE "ImagesOnReviews" ADD COLUMN     "index" INTEGER;

-- AlterTable
ALTER TABLE "ModelVersion" ADD COLUMN     "trainingDataUrl" TEXT;
