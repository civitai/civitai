-- CreateEnum
CREATE TYPE "ModelModifier" AS ENUM ('Archived', 'TakenDown');

-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "mode" "ModelModifier";
