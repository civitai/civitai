
-- AlterTable
ALTER TABLE "Article" ADD COLUMN     "nsfwLevel" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Bounty" ADD COLUMN     "nsfwLevel" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "BountyEntry" ADD COLUMN     "nsfwLevel" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "nsfwLevel" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Image" ADD COLUMN     "nsfwLevel" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "ModelVersion" ADD COLUMN     "nsfwLevel" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "nsfwLevel" INTEGER NOT NULL DEFAULT 1;

