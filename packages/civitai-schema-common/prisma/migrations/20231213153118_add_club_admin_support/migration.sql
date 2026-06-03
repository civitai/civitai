  BEGIN;
  -- CreateEnum
  CREATE TYPE "ClubAdminPermission" AS ENUM ('ManageMemberships', 'ManageTiers', 'ManagePosts', 'ManageClub', 'ManageResources', 'ViewRevenue', 'WithdrawRevenue');

  -- AlterTable
  ALTER TABLE "ClubMembership" DROP COLUMN "role",
  ADD COLUMN     "billingPausedAt" TIMESTAMP(3);

  -- DropEnum
  DROP TYPE "ClubMembershipRole";

  -- CreateTable
  CREATE TABLE "ClubAdminInvite" (
      "id" TEXT NOT NULL,
      "expiresAt" TIMESTAMP(3),
      "clubId" INTEGER NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "permissions" "ClubAdminPermission"[],

      CONSTRAINT "ClubAdminInvite_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "ClubAdmin" (
      "userId" INTEGER NOT NULL,
      "clubId" INTEGER NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "permissions" "ClubAdminPermission"[],

      CONSTRAINT "ClubAdmin_pkey" PRIMARY KEY ("clubId","userId")
  );

  -- AddForeignKey
  ALTER TABLE "ClubAdminInvite" ADD CONSTRAINT "ClubAdminInvite_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "ClubAdmin" ADD CONSTRAINT "ClubAdmin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "ClubAdmin" ADD CONSTRAINT "ClubAdmin_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  COMMIT;