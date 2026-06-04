-- CreateTable
CREATE TABLE "BountyMetric" (
    "bountyId" INTEGER NOT NULL,
    "timeframe" "MetricTimeframe" NOT NULL,
    "favoriteCount" INTEGER NOT NULL DEFAULT 0,
    "trackCount" INTEGER NOT NULL DEFAULT 0,
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "benefactorCount" INTEGER NOT NULL DEFAULT 0,
    "unitAmountCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BountyMetric_pkey" PRIMARY KEY ("bountyId","timeframe")
);

-- CreateTable
CREATE TABLE "BountyEntryMetric" (
    "bountyEntryId" INTEGER NOT NULL,
    "timeframe" "MetricTimeframe" NOT NULL,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "dislikeCount" INTEGER NOT NULL DEFAULT 0,
    "laughCount" INTEGER NOT NULL DEFAULT 0,
    "cryCount" INTEGER NOT NULL DEFAULT 0,
    "heartCount" INTEGER NOT NULL DEFAULT 0,
    "unitAmountCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BountyEntryMetric_pkey" PRIMARY KEY ("bountyEntryId","timeframe")
);

-- AddForeignKey
ALTER TABLE "BountyMetric" ADD CONSTRAINT "BountyMetric_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyEntryMetric" ADD CONSTRAINT "BountyEntryMetric_bountyEntryId_fkey" FOREIGN KEY ("bountyEntryId") REFERENCES "BountyEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
