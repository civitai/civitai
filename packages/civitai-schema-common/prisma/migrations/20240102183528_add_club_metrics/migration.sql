-- CreateTable
CREATE TABLE "ClubMetric" (
    "clubId" INTEGER NOT NULL,
    "timeframe" "MetricTimeframe" NOT NULL,
    "clubPostCount" INTEGER NOT NULL DEFAULT 0,
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "resourceCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ClubMetric_pkey" PRIMARY KEY ("clubId","timeframe")
);

-- AddForeignKey
ALTER TABLE "ClubMetric" ADD CONSTRAINT "ClubMetric_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
