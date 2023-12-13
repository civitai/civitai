/*
  Warnings:

  - A unique constraint covering the columns `[profilePictureId]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
BEGIN;
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "profilePictureId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "User_profilePictureId_key" ON "User"("profilePictureId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_profilePictureId_fkey" FOREIGN KEY ("profilePictureId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
