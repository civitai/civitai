-- CreateEnum
CREATE TYPE "TagsOnTagsType" AS ENUM ('Parent', 'Replace', 'Append');

-- AlterTable
ALTER TABLE "TagsOnTags" ADD COLUMN     "type" "TagsOnTagsType" NOT NULL DEFAULT 'Parent';
