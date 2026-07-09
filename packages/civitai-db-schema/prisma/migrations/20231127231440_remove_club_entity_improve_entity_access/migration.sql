BEGIN;
-- DropForeignKey
ALTER TABLE "ClubEntity" DROP CONSTRAINT "ClubEntity_addedById_fkey";

-- DropForeignKey
ALTER TABLE "ClubEntity" DROP CONSTRAINT "ClubEntity_clubId_fkey";

-- AlterTable
ALTER TABLE "EntityAccess" ADD COLUMN     "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "addedById" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "Model" DROP COLUMN "availability";

-- AlterTable
ALTER TABLE "ModelVersion" ADD COLUMN     "availability" "Availability" NOT NULL DEFAULT 'Public';

-- DropTable
DROP TABLE "ClubEntity";

-- CreateTable
CREATE TABLE "ClubPost" (
    "id" SERIAL NOT NULL,
    "clubId" INTEGER NOT NULL,
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "membersOnly" BOOLEAN NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "ClubPost_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "EntityAccess" ADD CONSTRAINT "EntityAccess_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubPost" ADD CONSTRAINT "ClubPost_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubPost" ADD CONSTRAINT "ClubPost_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
COMMIT;
