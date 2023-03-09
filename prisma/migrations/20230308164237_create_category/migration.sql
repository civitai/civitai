-- CreateEnum
CREATE TYPE "CategoryType" AS ENUM ('RealisticModels', 'SemiRealisticModels', 'AnimeModels', 'Models', 'Characters', 'Places', 'Concepts', 'Clothings', 'Styles', 'Poses', 'QualityEnhancements', 'Others');

-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "category" "CategoryType" NOT NULL DEFAULT 'Models';
