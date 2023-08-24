-- CreateTable
CREATE TABLE "CollectionMetric" (
    "collectionId" INTEGER NOT NULL,
    "timeframe" "MetricTimeframe" NOT NULL,
    "followerCount" INTEGER NOT NULL DEFAULT 0,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "contributorCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CollectionMetric_pkey" PRIMARY KEY ("collectionId","timeframe")
);

-- AddForeignKey
ALTER TABLE "CollectionMetric" ADD CONSTRAINT "CollectionMetric_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
