-- AlterTable
ALTER TABLE "ModelVersion" ADD COLUMN     "trainedWords" TEXT[];

-- Add Model Trained Words
UPDATE "ModelVersion"
SET "trainedWords" = "Model"."trainedWords"
FROM "Model"
WHERE "Model".id = "ModelVersion"."modelId";

-- AlterTable
ALTER TABLE "Model" DROP COLUMN "trainedWords";
