BEGIN;
-- CreateEnum
CREATE TYPE "Availability" AS ENUM ('Public', 'Private');

-- CreateEnum
CREATE TYPE "ClubMembershipRole" AS ENUM ('Admin', 'Contributor', 'Member');

-- AlterTable
ALTER TABLE "Article" ADD COLUMN     "availability" "Availability" NOT NULL DEFAULT 'Public',
ADD COLUMN     "unlisted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "availability" "Availability" NOT NULL DEFAULT 'Public',
ADD COLUMN     "unlisted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Link" (
    "id" SERIAL NOT NULL,
    "url" TEXT NOT NULL,
    "type" "LinkType" NOT NULL,
    "entityId" INTEGER NOT NULL,
    "entityType" TEXT NOT NULL,

    CONSTRAINT "Link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityAccess" (
    "accessToId" INTEGER NOT NULL,
    "accessToType" TEXT NOT NULL,
    "accessorId" INTEGER NOT NULL,
    "accessorType" TEXT NOT NULL,

    CONSTRAINT "EntityAccess_pkey" PRIMARY KEY ("accessToId","accessToType","accessorId","accessorType")
);

-- CreateTable
CREATE TABLE "Club" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "coverImageId" INTEGER,
    "headerImageId" INTEGER,
    "avatarId" INTEGER,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "nsfw" BOOLEAN NOT NULL DEFAULT false,
    "billing" BOOLEAN NOT NULL DEFAULT true,
    "unlisted" BOOLEAN NOT NULL DEFAULT false,
    "buzzAccountId" INTEGER,

    CONSTRAINT "Club_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubTier" (
    "id" SERIAL NOT NULL,
    "clubId" INTEGER NOT NULL,
    "unitAmount" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'BUZZ',
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "coverImageId" INTEGER,
    "unlisted" BOOLEAN NOT NULL DEFAULT false,
    "joinable" BOOLEAN NOT NULL,

    CONSTRAINT "ClubTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubMembership" (
    "userId" INTEGER NOT NULL,
    "clubId" INTEGER NOT NULL,
    "clubTierId" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "role" "ClubMembershipRole" NOT NULL DEFAULT 'Member',
    "nextBillingAt" TIMESTAMP(3) NOT NULL,
    "unitAmount" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'BUZZ'
);

-- CreateTable
CREATE TABLE "ClubMembershipCharge" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "clubId" INTEGER NOT NULL,
    "clubTierId" INTEGER NOT NULL,
    "chargedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT,
    "invoiceId" TEXT,
    "unitAmount" INTEGER NOT NULL,
    "unitAmountPurchased" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'BUZZ',

    CONSTRAINT "ClubMembershipCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubEntity" (
    "clubId" INTEGER NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" INTEGER NOT NULL,
    "addedById" INTEGER NOT NULL,
    "membersOnly" BOOLEAN NOT NULL,
    "clubTierId" INTEGER,
    "userId" INTEGER NOT NULL,

    CONSTRAINT "ClubEntity_pkey" PRIMARY KEY ("clubId","entityId")
);

-- CreateIndex
CREATE INDEX "Club_userId_idx" ON "Club"("userId");

-- CreateIndex
CREATE INDEX "ClubMembership_userId_idx" ON "ClubMembership"("userId");

-- CreateIndex
CREATE INDEX "ClubMembership_clubId_idx" ON "ClubMembership"("clubId");

-- CreateIndex
CREATE UNIQUE INDEX "ClubMembership_userId_clubId_key" ON "ClubMembership"("userId", "clubId");

-- AddForeignKey
ALTER TABLE "Club" ADD CONSTRAINT "Club_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Club" ADD CONSTRAINT "Club_coverImageId_fkey" FOREIGN KEY ("coverImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Club" ADD CONSTRAINT "Club_headerImageId_fkey" FOREIGN KEY ("headerImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Club" ADD CONSTRAINT "Club_avatarId_fkey" FOREIGN KEY ("avatarId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubTier" ADD CONSTRAINT "ClubTier_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubTier" ADD CONSTRAINT "ClubTier_coverImageId_fkey" FOREIGN KEY ("coverImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubMembership" ADD CONSTRAINT "ClubMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubMembership" ADD CONSTRAINT "ClubMembership_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubMembership" ADD CONSTRAINT "ClubMembership_clubTierId_fkey" FOREIGN KEY ("clubTierId") REFERENCES "ClubTier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubEntity" ADD CONSTRAINT "ClubEntity_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubEntity" ADD CONSTRAINT "ClubEntity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubEntity" ADD CONSTRAINT "ClubEntity_clubTierId_fkey" FOREIGN KEY ("clubTierId") REFERENCES "ClubTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
