/*
  Warnings:

  - A unique constraint covering the columns `[ethereumAddress]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "ethereumAddress" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_ethereumAddress_key" ON "User"("ethereumAddress");
