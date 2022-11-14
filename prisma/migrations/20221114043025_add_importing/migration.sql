/*
  Warnings:

  - A unique constraint covering the columns `[fromImportId]` on the table `Model` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[fromImportId]` on the table `ModelVersion` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('Pending', 'Processing', 'Failed', 'Completed');

-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "fromImportId" INTEGER;

-- AlterTable
ALTER TABLE "ModelVersion" ADD COLUMN     "fromImportId" INTEGER;

-- CreateTable
CREATE TABLE "Import" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'Pending',
    "data" JSONB,

    CONSTRAINT "Import_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Model_fromImportId_key" ON "Model"("fromImportId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelVersion_fromImportId_key" ON "ModelVersion"("fromImportId");

-- AddForeignKey
ALTER TABLE "Import" ADD CONSTRAINT "Import_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Model" ADD CONSTRAINT "Model_fromImportId_fkey" FOREIGN KEY ("fromImportId") REFERENCES "Import"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelVersion" ADD CONSTRAINT "ModelVersion_fromImportId_fkey" FOREIGN KEY ("fromImportId") REFERENCES "Import"("id") ON DELETE SET NULL ON UPDATE CASCADE;
