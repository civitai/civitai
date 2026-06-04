BEGIN;
-- AlterTable
ALTER TABLE "ClubMembership" ADD COLUMN     "downgradeClubTierId" INTEGER,
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "ClubMembership_pkey" PRIMARY KEY ("id");

-- AddForeignKey
ALTER TABLE "ClubMembership" ADD CONSTRAINT "ClubMembership_downgradeClubTierId_fkey" FOREIGN KEY ("downgradeClubTierId") REFERENCES "ClubTier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
COMMIT;
