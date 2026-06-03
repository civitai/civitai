/*
  Warnings:

  - You are about to drop the column `format` on the `ModelFile` table. All the data in the column will be lost.
  - You are about to drop the column `preferredModelFormat` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `preferredPrunedModel` on the `User` table. All the data in the column will be lost.

*/

-- AlterTable ModelFile
BEGIN;
ALTER TABLE "ModelFile" ADD COLUMN "metadata" JSONB;
UPDATE "ModelFile" SET "metadata" = jsonb_build_object(
  'format', format,
  'fp', 'fp16',
  'size', CASE
            WHEN type = 'Model' THEN 'full'
            WHEN type = 'Pruned Model' THEN 'pruned'
            ELSE null
          END
) WHERE type in ('Model', 'Pruned Model');
UPDATE "ModelFile" SET "metadata" = jsonb_build_object(
  'format', format
) WHERE type != 'Model' AND type != 'Pruned Model';

ALTER TABLE "ModelFile" DROP COLUMN "format";
COMMIT;

-- AlterTable User
BEGIN;
ALTER TABLE "User" ADD COLUMN "filePreferences" JSONB NOT NULL DEFAULT '{"size": "pruned", "fp": "fp16", "format": "SafeTensor"}';

UPDATE "User"
SET "filePreferences" = jsonb_build_object(
  'format', "User"."preferredModelFormat",
  'fp', 'fp16',
  'size', CASE
            WHEN "preferredPrunedModel" = false THEN 'full'
            WHEN "preferredPrunedModel" = true THEN 'pruned'
            ELSE null
          END
);

ALTER TABLE "User" DROP COLUMN "preferredModelFormat",
DROP COLUMN "preferredPrunedModel";
COMMIT;

-- DropEnum
DROP TYPE "ModelFileFormat";
