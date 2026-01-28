-- Add dual character creation flow support
-- Path 1: ExistingModel - user selects existing LoRA (instant)
-- Path 2: Upload - user uploads images, triggers training

-- Add new enum for source type
CREATE TYPE "ComicCharacterSourceType" AS ENUM ('Upload', 'ExistingModel');

-- Add new columns to comic_characters
ALTER TABLE "comic_characters" ADD COLUMN "sourceType" "ComicCharacterSourceType" NOT NULL DEFAULT 'Upload';
ALTER TABLE "comic_characters" ADD COLUMN "modelId" INTEGER;
ALTER TABLE "comic_characters" ADD COLUMN "modelVersionId" INTEGER;
ALTER TABLE "comic_characters" ADD COLUMN "trainingJobId" VARCHAR(100);
ALTER TABLE "comic_characters" ADD COLUMN "trainedModelId" INTEGER;
ALTER TABLE "comic_characters" ADD COLUMN "trainedModelVersionId" INTEGER;

-- Rename civitaiJobId to trainingJobId (migrate existing data)
UPDATE "comic_characters" SET "trainingJobId" = "civitaiJobId" WHERE "civitaiJobId" IS NOT NULL;

-- Drop old columns that are no longer needed
ALTER TABLE "comic_characters" DROP COLUMN IF EXISTS "civitaiJobId";
ALTER TABLE "comic_characters" DROP COLUMN IF EXISTS "faceEmbedding";
ALTER TABLE "comic_characters" DROP COLUMN IF EXISTS "characterEmbedding";

-- Add index for model version lookups
CREATE INDEX "comic_characters_modelVersionId_idx" ON "comic_characters"("modelVersionId");
