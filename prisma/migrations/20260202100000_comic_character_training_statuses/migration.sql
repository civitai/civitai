-- Add Training and GeneratingRefs values to ComicCharacterStatus enum
ALTER TYPE "ComicCharacterStatus" ADD VALUE IF NOT EXISTS 'Training';
ALTER TYPE "ComicCharacterStatus" ADD VALUE IF NOT EXISTS 'GeneratingRefs';

-- Migrate existing Processing rows to the appropriate new status
UPDATE "ComicCharacter" SET "status" = 'Training'
  WHERE "status" = 'Processing' AND "sourceType" = 'Upload';

UPDATE "ComicCharacter" SET "status" = 'GeneratingRefs'
  WHERE "status" = 'Processing' AND "sourceType" = 'ExistingModel';
