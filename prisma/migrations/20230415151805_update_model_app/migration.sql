/*
  Warnings:

  - You are about to drop the column `modelAppId` on the `Model` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "Model" DROP CONSTRAINT "Model_modelAppId_fkey";

-- AlterTable
ALTER TABLE "Model" DROP COLUMN "modelAppId",
ADD COLUMN     "appId" INTEGER;

-- CreateIndex
CREATE INDEX "ModelApp_name_idx" ON "ModelApp" USING HASH ("name");

-- AddForeignKey
ALTER TABLE "Model" ADD CONSTRAINT "Model_appId_fkey" FOREIGN KEY ("appId") REFERENCES "ModelApp"("id") ON DELETE SET NULL ON UPDATE CASCADE;
