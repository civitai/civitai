-- CreateTable
CREATE TABLE "AnnouncementReport" (
    "announcementId" INTEGER NOT NULL,
    "reportId" INTEGER NOT NULL,

    CONSTRAINT "AnnouncementReport_pkey" PRIMARY KEY ("reportId","announcementId")
);

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementReport_reportId_key" ON "AnnouncementReport"("reportId");

-- CreateIndex
CREATE INDEX "AnnouncementReport_announcementId_idx" ON "AnnouncementReport" USING HASH ("announcementId");

-- AddForeignKey
ALTER TABLE "AnnouncementReport" ADD CONSTRAINT "AnnouncementReport_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementReport" ADD CONSTRAINT "AnnouncementReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
