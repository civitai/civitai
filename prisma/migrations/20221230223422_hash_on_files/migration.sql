/*
  Warnings:

  - The primary key for the `ModelHash` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `modelVersionId` on the `ModelHash` table. All the data in the column will be lost.
  - Added the required column `fileId` to the `ModelHash` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "ModelHash" DROP CONSTRAINT "ModelHash_modelVersionId_fkey";

-- AlterTable
ALTER TABLE "ModelHash" DROP CONSTRAINT "ModelHash_pkey",
DROP COLUMN "modelVersionId",
ADD COLUMN     "fileId" INTEGER NOT NULL,
ADD CONSTRAINT "ModelHash_pkey" PRIMARY KEY ("fileId", "type");

-- AddForeignKey
ALTER TABLE "ModelHash" ADD CONSTRAINT "ModelHash_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "ModelFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
