-- CreateEnum
CREATE TYPE "ChallengeSource" AS ENUM ('System', 'Mod', 'User');

-- CreateEnum
CREATE TYPE "ChallengeStatus" AS ENUM ('Draft', 'Scheduled', 'Active', 'Judging', 'Completed', 'Cancelled');

-- CreateEnum
CREATE TYPE "ChallengeEntryStatus" AS ENUM ('Pending', 'Accepted', 'Rejected', 'Scored');

-- CreateTable
CREATE TABLE "Challenge" (
    "id" SERIAL NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "visibleAt" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "theme" TEXT,
    "invitation" TEXT,
    "coverImageId" INTEGER,
    "nsfwLevel" INTEGER NOT NULL DEFAULT 1,
    "modelId" INTEGER,
    "modelVersionId" INTEGER,
    "judgingPrompt" TEXT,
    "reviewPercentage" INTEGER NOT NULL DEFAULT 100,
    "maxReviews" INTEGER,
    "collectionId" INTEGER,
    "maxEntriesPerUser" INTEGER NOT NULL DEFAULT 20,
    "prizes" JSONB NOT NULL DEFAULT '[]',
    "entryPrize" JSONB,
    "prizePool" INTEGER NOT NULL DEFAULT 0,
    "operationBudget" INTEGER NOT NULL DEFAULT 0,
    "operationSpent" INTEGER NOT NULL DEFAULT 0,
    "createdById" INTEGER NOT NULL,
    "source" "ChallengeSource" NOT NULL DEFAULT 'System',
    "status" "ChallengeStatus" NOT NULL DEFAULT 'Draft',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChallengeEntry" (
    "id" SERIAL NOT NULL,
    "challengeId" INTEGER NOT NULL,
    "imageId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "score" JSONB,
    "aiSummary" TEXT,
    "status" "ChallengeEntryStatus" NOT NULL DEFAULT 'Pending',
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChallengeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChallengeWinner" (
    "id" SERIAL NOT NULL,
    "challengeId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "imageId" INTEGER NOT NULL,
    "place" INTEGER NOT NULL,
    "buzzAwarded" INTEGER NOT NULL,
    "pointsAwarded" INTEGER NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChallengeWinner_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Challenge_status_idx" ON "Challenge"("status");

-- CreateIndex
CREATE INDEX "Challenge_startsAt_idx" ON "Challenge"("startsAt");

-- CreateIndex
CREATE INDEX "Challenge_endsAt_idx" ON "Challenge"("endsAt");

-- CreateIndex
CREATE INDEX "Challenge_visibleAt_idx" ON "Challenge"("visibleAt");

-- CreateIndex
CREATE INDEX "Challenge_createdById_idx" ON "Challenge"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "ChallengeEntry_challengeId_imageId_key" ON "ChallengeEntry"("challengeId", "imageId");

-- CreateIndex
CREATE INDEX "ChallengeEntry_challengeId_idx" ON "ChallengeEntry"("challengeId");

-- CreateIndex
CREATE INDEX "ChallengeEntry_userId_idx" ON "ChallengeEntry"("userId");

-- CreateIndex
CREATE INDEX "ChallengeEntry_status_idx" ON "ChallengeEntry"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ChallengeWinner_challengeId_place_key" ON "ChallengeWinner"("challengeId", "place");

-- CreateIndex
CREATE INDEX "ChallengeWinner_challengeId_idx" ON "ChallengeWinner"("challengeId");

-- CreateIndex
CREATE INDEX "ChallengeWinner_userId_idx" ON "ChallengeWinner"("userId");

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_coverImageId_fkey" FOREIGN KEY ("coverImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChallengeEntry" ADD CONSTRAINT "ChallengeEntry_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChallengeEntry" ADD CONSTRAINT "ChallengeEntry_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChallengeEntry" ADD CONSTRAINT "ChallengeEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChallengeEntry" ADD CONSTRAINT "ChallengeEntry_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChallengeWinner" ADD CONSTRAINT "ChallengeWinner_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChallengeWinner" ADD CONSTRAINT "ChallengeWinner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChallengeWinner" ADD CONSTRAINT "ChallengeWinner_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;
