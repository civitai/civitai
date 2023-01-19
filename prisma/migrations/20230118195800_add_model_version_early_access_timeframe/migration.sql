/*
  Warnings:

  - You are about to drop the column `earlyAccessTimeFrame` on the `Model` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Model" DROP COLUMN "earlyAccessTimeFrame";

-- AlterTable
ALTER TABLE "ModelVersion" ADD COLUMN     "earlyAccessTimeFrame" INTEGER NOT NULL DEFAULT 0;
