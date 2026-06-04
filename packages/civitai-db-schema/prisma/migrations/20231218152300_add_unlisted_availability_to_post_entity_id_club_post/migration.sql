-- AlterTable
ALTER TABLE "ClubPost" ADD COLUMN     "entityId" INTEGER,
ADD COLUMN     "entityType" TEXT;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "availability" "Availability" NOT NULL DEFAULT 'Public',
ADD COLUMN     "unlisted" BOOLEAN NOT NULL DEFAULT false;
