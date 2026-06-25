-- CreateTable
CREATE TABLE "RewardsBonusEvent" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "multiplier" INTEGER NOT NULL,
    "articleId" INTEGER,
    "bannerLabel" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardsBonusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RewardsBonusEvent_enabled_startsAt_endsAt_idx" ON "RewardsBonusEvent"("enabled", "startsAt", "endsAt");

-- AddForeignKey
ALTER TABLE "RewardsBonusEvent" ADD CONSTRAINT "RewardsBonusEvent_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardsBonusEvent" ADD CONSTRAINT "RewardsBonusEvent_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
