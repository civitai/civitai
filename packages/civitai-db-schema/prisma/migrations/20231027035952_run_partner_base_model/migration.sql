-- AlterTable
ALTER TABLE "Partner" ADD COLUMN     "onDemandBaseModels" TEXT[] DEFAULT ARRAY[]::TEXT[];
