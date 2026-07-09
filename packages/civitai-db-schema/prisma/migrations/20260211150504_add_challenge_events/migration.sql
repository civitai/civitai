-- CreateTable
CREATE TABLE "ChallengeEvent" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChallengeEvent_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Challenge" ADD COLUMN "eventId" INTEGER;

-- CreateIndex
CREATE INDEX "ChallengeEvent_active_endDate_idx" ON "ChallengeEvent"("active", "endDate");

-- CreateIndex
CREATE INDEX "Challenge_eventId_idx" ON "Challenge"("eventId");

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "ChallengeEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChallengeEvent" ADD CONSTRAINT "ChallengeEvent_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "ChallengeEvent" ADD COLUMN "titleColor" TEXT;
