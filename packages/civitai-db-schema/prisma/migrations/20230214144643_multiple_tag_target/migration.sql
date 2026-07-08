/*
  Warnings:

  - Changed the column `target` on the `Tag` table from a scalar field to a list field. If there are non-null values in that column, this step will fail.

*/
-- AlterTable
ALTER TABLE "Tag" ALTER COLUMN "target" SET DATA TYPE "TagTarget"[] USING ARRAY["target"]; ;

UPDATE "Tag" SET "target" = array_append("target", 'Image') WHERE 'Model' = ANY("target");
