-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('USD', 'BUZZ');

-- CreateEnum
CREATE TYPE "BountyType" AS ENUM ('ModelCreation', 'LoraCreation', 'EmbedCreation', 'DataSetCreation', 'DataSetCaption', 'ImageCreation', 'VideoCreation', 'Other');

-- CreateEnum
CREATE TYPE "BountyMode" AS ENUM ('Individual', 'Split');

-- CreateEnum
CREATE TYPE "BountyEntryMode" AS ENUM ('Open', 'BenefactorsOnly');

-- CreateEnum
CREATE TYPE "BountyEngagementType" AS ENUM ('Favorite', 'Track');

-- AlterEnum
ALTER TYPE "TagTarget" ADD VALUE 'Bounty';

-- DropForeignKey
ALTER TABLE "File" DROP CONSTRAINT "File_articleId_fkey";

-- DropIndex
DROP INDEX "File_articleId_idx";

-- AlterTable
ALTER TABLE "File"
ADD COLUMN     "entityId" INTEGER,
ADD COLUMN     "entityType" TEXT;

UPDATE "File" SET "entityType" = 'Article', "entityId" = f."articleId"
FROM "File" f WHERE f."articleId" IS NOT NULL;


ALTER TABLE "File" DROP COLUMN "articleId",
ALTER COLUMN "entityId" SET NOT NULL,
ALTER COLUMN "entityType" SET NOT NULL;

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "bountyEntryId" INTEGER,
ADD COLUMN     "bountyId" INTEGER;

-- CreateTable
CREATE TABLE "ImageConnection" (
    "imageId" INTEGER NOT NULL,
    "entityId" INTEGER NOT NULL,
    "entityType" TEXT NOT NULL,

    CONSTRAINT "ImageConnection_pkey" PRIMARY KEY ("imageId","entityId","entityType")
);

-- CreateTable
CREATE TABLE "TagsOnBounty" (
    "bountyId" INTEGER NOT NULL,
    "tagId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TagsOnBounty_pkey" PRIMARY KEY ("tagId","bountyId")
);

-- CreateTable
CREATE TABLE "Bounty" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "details" JSONB,
    "mode" "BountyMode" NOT NULL DEFAULT 'Individual',
    "entryMode" "BountyEntryMode" NOT NULL DEFAULT 'Open',
    "type" "BountyType" NOT NULL,
    "minBenefactorUnitAmount" INTEGER NOT NULL,
    "maxBenefactorUnitAmount" INTEGER,
    "entryLimit" INTEGER NOT NULL DEFAULT 1,
    "nsfw" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Bounty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BountyEntry" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER,
    "bountyId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "locked" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "BountyEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BountyEntryReaction" (
    "bountyEntryId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "reaction" "ReviewReactions" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BountyEntryReaction_pkey" PRIMARY KEY ("bountyEntryId","userId","reaction")
);

-- CreateTable
CREATE TABLE "BountyBenefactor" (
    "userId" INTEGER NOT NULL,
    "bountyId" INTEGER NOT NULL,
    "unitAmount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "awardedAt" TIMESTAMP(3),
    "awardedToId" INTEGER,
    "currency" "Currency" NOT NULL DEFAULT 'BUZZ',

    CONSTRAINT "BountyBenefactor_pkey" PRIMARY KEY ("userId","bountyId")
);

-- CreateTable
CREATE TABLE "BountyEngagement" (
    "userId" INTEGER NOT NULL,
    "bountyId" INTEGER NOT NULL,
    "type" "BountyEngagementType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BountyEngagement_pkey" PRIMARY KEY ("userId","bountyId","type")
);

-- CreateTable
CREATE TABLE "TipConnection" (
    "transactionId" TEXT NOT NULL,
    "entityId" INTEGER NOT NULL,
    "entityType" TEXT NOT NULL,

    CONSTRAINT "TipConnection_pkey" PRIMARY KEY ("entityId","entityType","transactionId")
);

-- CreateIndex
CREATE INDEX "TagsOnBounty_bountyId_idx" ON "TagsOnBounty" USING HASH ("bountyId");

-- CreateIndex
CREATE INDEX "BountyEngagement_bountyId_idx" ON "BountyEngagement"("bountyId");

-- CreateIndex
CREATE UNIQUE INDEX "File_id_entityId_entityType_key" ON "File"("id", "entityId", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "Thread_bountyId_key" ON "Thread"("bountyId");

-- CreateIndex
CREATE UNIQUE INDEX "Thread_bountyEntryId_key" ON "Thread"("bountyEntryId");

-- AddForeignKey
ALTER TABLE "ImageConnection" ADD CONSTRAINT "ImageConnection_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnBounty" ADD CONSTRAINT "TagsOnBounty_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnBounty" ADD CONSTRAINT "TagsOnBounty_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_bountyEntryId_fkey" FOREIGN KEY ("bountyEntryId") REFERENCES "BountyEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bounty" ADD CONSTRAINT "Bounty_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyEntry" ADD CONSTRAINT "BountyEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyEntry" ADD CONSTRAINT "BountyEntry_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyEntryReaction" ADD CONSTRAINT "BountyEntryReaction_bountyEntryId_fkey" FOREIGN KEY ("bountyEntryId") REFERENCES "BountyEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyEntryReaction" ADD CONSTRAINT "BountyEntryReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyBenefactor" ADD CONSTRAINT "BountyBenefactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyBenefactor" ADD CONSTRAINT "BountyBenefactor_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyBenefactor" ADD CONSTRAINT "BountyBenefactor_awardedToId_fkey" FOREIGN KEY ("awardedToId") REFERENCES "BountyEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyEngagement" ADD CONSTRAINT "BountyEngagement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyEngagement" ADD CONSTRAINT "BountyEngagement_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty"("id") ON DELETE CASCADE ON UPDATE CASCADE;
