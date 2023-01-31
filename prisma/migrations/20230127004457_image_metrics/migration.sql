-- CreateTable
CREATE TABLE "ImageMetric" (
    "imageId" INTEGER NOT NULL,
    "timeframe" "MetricTimeframe" NOT NULL,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "dislikeCount" INTEGER NOT NULL DEFAULT 0,
    "laughCount" INTEGER NOT NULL DEFAULT 0,
    "cryCount" INTEGER NOT NULL DEFAULT 0,
    "heartCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ImageMetric_pkey" PRIMARY KEY ("imageId","timeframe")
);

-- AddForeignKey
ALTER TABLE "ImageMetric" ADD CONSTRAINT "ImageMetric_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;
