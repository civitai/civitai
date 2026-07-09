/*
  Warnings:

  - The values [VAE] on the enum `ModelType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "ModelType_new" AS ENUM ('Checkpoint', 'TextualInversion', 'Hypernetwork', 'AestheticGradient', 'LORA');
ALTER TABLE "Model" ALTER COLUMN "type" TYPE "ModelType_new" USING ("type"::text::"ModelType_new");
ALTER TYPE "ModelType" RENAME TO "ModelType_old";
ALTER TYPE "ModelType_new" RENAME TO "ModelType";
DROP TYPE "ModelType_old";
COMMIT;
