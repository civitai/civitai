-- CreateTable
CREATE TABLE "ImageRatingRequest" (
    "userId" INTEGER NOT NULL,
    "imageId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nsfwLevel" INTEGER NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'Pending',

    CONSTRAINT "ImageRatingRequest_pkey" PRIMARY KEY ("imageId","userId")
);
