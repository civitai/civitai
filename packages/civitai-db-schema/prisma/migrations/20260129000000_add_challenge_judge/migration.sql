-- CreateTable
CREATE TABLE "ChallengeJudge" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "bio" TEXT,
    "systemPrompt" TEXT,
    "reviewPrompt" TEXT,
    "winnerSelectionPrompt" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChallengeJudge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChallengeJudge_userId_key" ON "ChallengeJudge"("userId");

-- CreateIndex
CREATE INDEX "ChallengeJudge_active_idx" ON "ChallengeJudge"("active");

-- AddForeignKey
ALTER TABLE "ChallengeJudge" ADD CONSTRAINT "ChallengeJudge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: Add judgeId to Challenge
ALTER TABLE "Challenge" ADD COLUMN "judgeId" INTEGER;

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_judgeId_fkey" FOREIGN KEY ("judgeId") REFERENCES "ChallengeJudge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Challenge_judgeId_idx" ON "Challenge"("judgeId");
