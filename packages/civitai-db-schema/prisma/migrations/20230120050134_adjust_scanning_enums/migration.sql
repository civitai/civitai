/*
  Warnings:

  - The values [CRC] on the enum `ModelHashType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "ModelHashType_new" AS ENUM ('AutoV1', 'AutoV2', 'SHA256', 'CRC32', 'BLAKE3');
ALTER TABLE "ModelHash" ALTER COLUMN "type" TYPE "ModelHashType_new" USING ("type"::text::"ModelHashType_new");
ALTER TYPE "ModelHashType" RENAME TO "ModelHashType_old";
ALTER TYPE "ModelHashType_new" RENAME TO "ModelHashType";
DROP TYPE "ModelHashType_old";
COMMIT;

-- AlterEnum
ALTER TYPE "UserActivityType" ADD VALUE 'OtherDownload';
