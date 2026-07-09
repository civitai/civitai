-- CreateEnum
CREATE TYPE "TagType" AS ENUM ('UserGenerated', 'Label', 'Moderation');

-- AlterTable
ALTER TABLE "Tag" ADD COLUMN     "type" "TagType" NOT NULL DEFAULT 'UserGenerated';

-- AlterTable
ALTER TABLE "TagsOnImage" ADD COLUMN     "automated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "confidence" INTEGER;
