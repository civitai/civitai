-- CreateTable
CREATE TABLE "ResourceReviewReport" (
    "resourceReviewId" INTEGER NOT NULL,
    "reportId" INTEGER NOT NULL,

    CONSTRAINT "ResourceReviewReport_pkey" PRIMARY KEY ("reportId","resourceReviewId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ResourceReviewReport_reportId_key" ON "ResourceReviewReport"("reportId");

-- AddForeignKey
ALTER TABLE "ResourceReviewReport" ADD CONSTRAINT "ResourceReviewReport_resourceReviewId_fkey" FOREIGN KEY ("resourceReviewId") REFERENCES "ResourceReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceReviewReport" ADD CONSTRAINT "ResourceReviewReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
