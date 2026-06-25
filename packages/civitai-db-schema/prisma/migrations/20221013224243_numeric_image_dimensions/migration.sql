/*
  Warnings:

  - The `height` column on the `Image` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `width` column on the `Image` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "Image" DROP COLUMN "height",
ADD COLUMN     "height" INTEGER,
DROP COLUMN "width",
ADD COLUMN     "width" INTEGER;
