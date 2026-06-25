/*
  Warnings:

  - You are about to drop the column `prompt` on the `Image` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Image" DROP COLUMN "prompt",
ADD COLUMN     "meta" JSONB;
