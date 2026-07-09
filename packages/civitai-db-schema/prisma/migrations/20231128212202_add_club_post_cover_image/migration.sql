BEGIN;
-- AlterTable
ALTER TABLE "ClubPost" ADD COLUMN     "coverImageId" INTEGER;

-- AddForeignKey
ALTER TABLE "ClubPost" ADD CONSTRAINT "ClubPost_coverImageId_fkey" FOREIGN KEY ("coverImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
