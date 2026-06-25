/*
  Warnings:

  - You are about to drop the column `enabled` on the `Announcement` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Announcement" DROP COLUMN "enabled",
ADD COLUMN     "disabled" BOOLEAN NOT NULL DEFAULT false;
