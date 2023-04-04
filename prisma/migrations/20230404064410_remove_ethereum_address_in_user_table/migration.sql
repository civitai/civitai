/*
  Warnings:

  - You are about to drop the column `ethereumAddress` on the `User` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "User_ethereumAddress_key";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "ethereumAddress";
