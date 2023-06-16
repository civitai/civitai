-- CreateTable
CREATE TABLE "UserReport" (
    "userId" INTEGER NOT NULL,
    "reportId" INTEGER NOT NULL,

    CONSTRAINT "UserReport_pkey" PRIMARY KEY ("reportId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserReport_reportId_key" ON "UserReport"("reportId");

-- AddForeignKey
ALTER TABLE "UserReport" ADD CONSTRAINT "UserReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserReport" ADD CONSTRAINT "UserReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
