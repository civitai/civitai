/*
  Warnings:

  - Added the required column `index` to the `UserLink` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "UserLink" ADD COLUMN     "index" INTEGER NOT NULL;
