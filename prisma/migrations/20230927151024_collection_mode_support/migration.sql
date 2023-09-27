BEGIN;
-- CreateEnum
CREATE TYPE "CollectionMode" AS ENUM ('Contest');

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "mode" "CollectionMode";

COMMIT;
