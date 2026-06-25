/*
  Warnings:

  - The primary key for the `ModelFile` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- AlterEnum
ALTER TYPE "ModelFileFormat" ADD VALUE 'Other';

-- AlterTable
ALTER TABLE "ModelFile" DROP CONSTRAINT "ModelFile_pkey",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "ModelFile_pkey" PRIMARY KEY ("id");
