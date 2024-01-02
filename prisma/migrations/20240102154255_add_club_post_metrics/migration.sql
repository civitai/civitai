-- CreateTable
CREATE TABLE "ClubPostMetric" (
    "clubPostId" INTEGER NOT NULL,
    "timeframe" "MetricTimeframe" NOT NULL,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "dislikeCount" INTEGER NOT NULL DEFAULT 0,
    "laughCount" INTEGER NOT NULL DEFAULT 0,
    "cryCount" INTEGER NOT NULL DEFAULT 0,
    "heartCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ClubPostMetric_pkey" PRIMARY KEY ("clubPostId","timeframe")
);
 

-- AddForeignKey
ALTER TABLE "ClubPostMetric" ADD CONSTRAINT "ClubPostMetric_clubPostId_fkey" FOREIGN KEY ("clubPostId") REFERENCES "ClubPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
