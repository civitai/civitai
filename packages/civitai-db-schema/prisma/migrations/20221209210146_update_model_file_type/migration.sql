-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.

ALTER TYPE "ModelFileType" ADD VALUE 'PrunedModel';


ALTER TYPE "ModelFileType" ADD VALUE 'VAE';


ALTER TYPE "ModelFileType" ADD VALUE 'Config';

-- AlterTable

ALTER TABLE "ModelFile" ADD COLUMN "primary" BOOLEAN NOT NULL DEFAULT false;

-- Update ModelFile to set primary

UPDATE "ModelFile"
SET "primary" = true
WHERE "type" = 'Model';

