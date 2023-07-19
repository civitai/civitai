-- CreateEnum
CREATE TYPE "CollectionType" AS ENUM ('Model', 'Article', 'Post', 'Image');

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "type" "CollectionType";
