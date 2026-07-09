/*
  Warnings:

  - Added the required column `target` to the `Tag` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "TagTarget" AS ENUM ('Model', 'Question');

-- AlterTable
ALTER TABLE "Tag" ADD COLUMN     "target" "TagTarget";
UPDATE "Tag" SET "target" = 'Model';
ALTER TABLE "Tag" ALTER COLUMN     "target" SET NOT NULL;
