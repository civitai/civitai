/*
  Warnings:

  - The values [CustomModels] on the enum `CategoryType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "CategoryType_new" AS ENUM ('RealisticModels', 'SemiRealisticModels', 'AnimeModels', 'Models', 'Characters', 'Places', 'Concepts', 'Clothings', 'Styles', 'Poses', 'QualityEnhancements', 'Others');
ALTER TABLE "Model" ALTER COLUMN "category" DROP DEFAULT;
ALTER TABLE "Model" ALTER COLUMN "category" TYPE "CategoryType_new" USING ("category"::text::"CategoryType_new");
ALTER TYPE "CategoryType" RENAME TO "CategoryType_old";
ALTER TYPE "CategoryType_new" RENAME TO "CategoryType";
DROP TYPE "CategoryType_old";
ALTER TABLE "Model" ALTER COLUMN "category" SET DEFAULT 'SemiRealisticModels';
COMMIT;

-- AlterTable
ALTER TABLE "Model" ALTER COLUMN "category" SET DEFAULT 'SemiRealisticModels';
