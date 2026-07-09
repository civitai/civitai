-- CreateTable
CREATE TABLE "ComicProjectReport" (
    "comicProjectId" INTEGER NOT NULL,
    "reportId" INTEGER NOT NULL,

    CONSTRAINT "ComicProjectReport_pkey" PRIMARY KEY ("reportId","comicProjectId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ComicProjectReport_reportId_key" ON "ComicProjectReport"("reportId");

-- CreateIndex
CREATE INDEX "ComicProjectReport_comicProjectId_idx" ON "ComicProjectReport" USING HASH ("comicProjectId");

-- AddForeignKey
ALTER TABLE "ComicProjectReport" ADD CONSTRAINT "ComicProjectReport_comicProjectId_fkey" FOREIGN KEY ("comicProjectId") REFERENCES "ComicProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComicProjectReport" ADD CONSTRAINT "ComicProjectReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
