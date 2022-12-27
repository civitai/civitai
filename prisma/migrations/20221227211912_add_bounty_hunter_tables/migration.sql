-- AlterTable
ALTER TABLE "Tag" ADD COLUMN     "bountyId" INTEGER;

-- CreateTable
CREATE TABLE "Bounty" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" "ModelType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadline" TIMESTAMP(3),
    "nsfw" BOOLEAN NOT NULL DEFAULT false,
    "poi" BOOLEAN NOT NULL DEFAULT false,
    "awardedAt" TIMESTAMP(3),
    "userId" INTEGER NOT NULL,

    CONSTRAINT "Bounty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Benefactor" (
    "id" SERIAL NOT NULL,
    "bountyId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "contribution" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Benefactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FavoriteBounty" (
    "bountyId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FavoriteBounty_pkey" PRIMARY KEY ("bountyId","userId")
);

-- CreateTable
CREATE TABLE "ImagesOnBounty" (
    "bountyId" INTEGER NOT NULL,
    "imageId" INTEGER NOT NULL,
    "index" INTEGER,

    CONSTRAINT "ImagesOnBounty_pkey" PRIMARY KEY ("imageId","bountyId")
);

-- CreateTable
CREATE TABLE "BountyFile" (
    "id" SERIAL NOT NULL,
    "bountyId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sizeKB" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL DEFAULT 'Training Data',

    CONSTRAINT "BountyFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hunter" (
    "id" SERIAL NOT NULL,
    "bountyId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Hunter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImagesOnHunter" (
    "hunterId" INTEGER NOT NULL,
    "imageId" INTEGER NOT NULL,
    "index" INTEGER,
    "hunterBountyId" INTEGER NOT NULL,
    "hunterUserId" INTEGER NOT NULL,

    CONSTRAINT "ImagesOnHunter_pkey" PRIMARY KEY ("imageId","hunterId")
);

-- CreateTable
CREATE TABLE "FavoriteHunter" (
    "hunterId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hunterBountyId" INTEGER NOT NULL,
    "hunterUserId" INTEGER NOT NULL,

    CONSTRAINT "FavoriteHunter_pkey" PRIMARY KEY ("hunterId","userId")
);

-- CreateTable
CREATE TABLE "BountyMetric" (
    "bountyId" INTEGER NOT NULL,
    "timeframe" "MetricTimeframe" NOT NULL,
    "favoriteCount" INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "hunterCount" INTEGER NOT NULL DEFAULT 0,
    "benefactorCount" INTEGER NOT NULL DEFAULT 0,
    "bountyValue" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BountyMetric_pkey" PRIMARY KEY ("bountyId","timeframe")
);

-- CreateTable
CREATE TABLE "HunterMetric" (
    "hunterId" INTEGER NOT NULL,
    "timeframe" "MetricTimeframe" NOT NULL,
    "favoriteCount" INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "hunterBountyId" INTEGER NOT NULL,
    "hunterUserId" INTEGER NOT NULL,

    CONSTRAINT "HunterMetric_pkey" PRIMARY KEY ("hunterId","timeframe")
);

-- CreateIndex
CREATE UNIQUE INDEX "Benefactor_bountyId_userId_key" ON "Benefactor"("bountyId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Hunter_bountyId_userId_key" ON "Hunter"("bountyId", "userId");

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bounty" ADD CONSTRAINT "Bounty_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Benefactor" ADD CONSTRAINT "Benefactor_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Benefactor" ADD CONSTRAINT "Benefactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FavoriteBounty" ADD CONSTRAINT "FavoriteBounty_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FavoriteBounty" ADD CONSTRAINT "FavoriteBounty_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImagesOnBounty" ADD CONSTRAINT "ImagesOnBounty_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImagesOnBounty" ADD CONSTRAINT "ImagesOnBounty_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyFile" ADD CONSTRAINT "BountyFile_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hunter" ADD CONSTRAINT "Hunter_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hunter" ADD CONSTRAINT "Hunter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImagesOnHunter" ADD CONSTRAINT "ImagesOnHunter_hunterBountyId_hunterUserId_fkey" FOREIGN KEY ("hunterBountyId", "hunterUserId") REFERENCES "Hunter"("bountyId", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImagesOnHunter" ADD CONSTRAINT "ImagesOnHunter_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FavoriteHunter" ADD CONSTRAINT "FavoriteHunter_hunterBountyId_hunterUserId_fkey" FOREIGN KEY ("hunterBountyId", "hunterUserId") REFERENCES "Hunter"("bountyId", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FavoriteHunter" ADD CONSTRAINT "FavoriteHunter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyMetric" ADD CONSTRAINT "BountyMetric_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HunterMetric" ADD CONSTRAINT "HunterMetric_hunterBountyId_hunterUserId_fkey" FOREIGN KEY ("hunterBountyId", "hunterUserId") REFERENCES "Hunter"("bountyId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
