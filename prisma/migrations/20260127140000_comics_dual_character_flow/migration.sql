-- Add dual character creation flow support
-- Path 1: ExistingModel - user selects existing LoRA (instant)
-- Path 2: Upload - user uploads images, triggers training

-- Add new enum for source type
CREATE TYPE "ComicCharacterSourceType" AS ENUM ('Upload', 'ExistingModel');

-- Add new columns to ComicCharacter
ALTER TABLE "ComicCharacter" ADD COLUMN "sourceType" "ComicCharacterSourceType" NOT NULL DEFAULT 'Upload';
ALTER TABLE "ComicCharacter" ADD COLUMN "modelId" INTEGER;
ALTER TABLE "ComicCharacter" ADD COLUMN "modelVersionId" INTEGER;
ALTER TABLE "ComicCharacter" ADD COLUMN "trainingJobId" VARCHAR(100);
ALTER TABLE "ComicCharacter" ADD COLUMN "trainedModelId" INTEGER;
ALTER TABLE "ComicCharacter" ADD COLUMN "trainedModelVersionId" INTEGER;

-- Rename civitaiJobId to trainingJobId (migrate existing data)
UPDATE "ComicCharacter" SET "trainingJobId" = "civitaiJobId" WHERE "civitaiJobId" IS NOT NULL;

-- Drop old columns that are no longer needed
ALTER TABLE "ComicCharacter" DROP COLUMN IF EXISTS "civitaiJobId";
ALTER TABLE "ComicCharacter" DROP COLUMN IF EXISTS "faceEmbedding";
ALTER TABLE "ComicCharacter" DROP COLUMN IF EXISTS "characterEmbedding";

-- Add index for model version lookups
CREATE INDEX "ComicCharacter_modelVersionId_idx" ON "ComicCharacter"("modelVersionId");
