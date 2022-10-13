-- AlterEnum
ALTER TYPE "ModelType" ADD VALUE 'Hypernetwork';

-- AlterTable
ALTER TABLE "Image" ADD COLUMN     "height" TEXT,
ADD COLUMN     "width" TEXT;

-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "nsfw" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "nsfw" BOOLEAN NOT NULL DEFAULT false;
