BEGIN;
-- DropForeignKey
ALTER TABLE "ClubEntity" DROP CONSTRAINT "ClubEntity_clubTierId_fkey";

-- DropForeignKey
ALTER TABLE "ClubEntity" DROP CONSTRAINT "ClubEntity_userId_fkey";

-- AlterTable
ALTER TABLE "ClubEntity" DROP CONSTRAINT "ClubEntity_pkey",
DROP COLUMN "clubTierId",
DROP COLUMN "userId",
ADD COLUMN     "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "description" TEXT NOT NULL,
ADD COLUMN     "title" TEXT NOT NULL,
ADD CONSTRAINT "ClubEntity_pkey" PRIMARY KEY ("clubId", "entityId", "entityType");

-- AddForeignKey
ALTER TABLE "ClubEntity" ADD CONSTRAINT "ClubEntity_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
