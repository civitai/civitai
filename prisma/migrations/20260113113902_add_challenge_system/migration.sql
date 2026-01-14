-- CreateEnum
CREATE TYPE "ChallengeSource" AS ENUM ('System', 'Mod', 'User');

-- CreateEnum
CREATE TYPE "ChallengeStatus" AS ENUM ('Draft', 'Scheduled', 'Active', 'Judging', 'Completed', 'Cancelled');

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
    "allowedNsfwLevel" INTEGER NOT NULL DEFAULT 1,
    "modelId" INTEGER,
    "modelVersionIds" INTEGER[] DEFAULT '{}',
    "judgingPrompt" TEXT,
    "reviewPercentage" INTEGER NOT NULL DEFAULT 100,
    "maxReviews" INTEGER,
    "collectionId" INTEGER,
    "maxEntriesPerUser" INTEGER NOT NULL DEFAULT 20,
    "prizes" JSONB NOT NULL DEFAULT '[]',
    "entryPrize" JSONB,
    "entryPrizeRequirement" INTEGER NOT NULL DEFAULT 10,
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

-- CreateIndex (single column)
CREATE INDEX "Challenge_status_idx" ON "Challenge"("status");
CREATE INDEX "Challenge_startsAt_idx" ON "Challenge"("startsAt");
CREATE INDEX "Challenge_endsAt_idx" ON "Challenge"("endsAt");
CREATE INDEX "Challenge_visibleAt_idx" ON "Challenge"("visibleAt");
CREATE INDEX "Challenge_createdById_idx" ON "Challenge"("createdById");

-- CreateIndex (compound for feed queries)
CREATE INDEX "Challenge_status_endsAt_idx" ON "Challenge"("status", "endsAt");
CREATE INDEX "Challenge_status_startsAt_idx" ON "Challenge"("status", "startsAt");
CREATE INDEX "Challenge_status_visibleAt_idx" ON "Challenge"("status", "visibleAt");
CREATE INDEX "Challenge_createdById_status_idx" ON "Challenge"("createdById", "status");

-- CreateIndex (ChallengeWinner)
CREATE UNIQUE INDEX "ChallengeWinner_challengeId_userId_key" ON "ChallengeWinner"("challengeId", "userId");
CREATE INDEX "ChallengeWinner_challengeId_idx" ON "ChallengeWinner"("challengeId");
CREATE INDEX "ChallengeWinner_userId_idx" ON "ChallengeWinner"("userId");

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_coverImageId_fkey" FOREIGN KEY ("coverImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChallengeWinner" ADD CONSTRAINT "ChallengeWinner_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChallengeWinner" ADD CONSTRAINT "ChallengeWinner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChallengeWinner" ADD CONSTRAINT "ChallengeWinner_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;
