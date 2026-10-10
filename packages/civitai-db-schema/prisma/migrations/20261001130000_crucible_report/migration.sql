-- Crucible reports: the join row a report of a crucible lives in, as for every other report type.
-- A new table only, so applying it ahead of or behind the deploy is harmless.

-- CreateTable
CREATE TABLE "CrucibleReport" (
    "crucibleId" INTEGER NOT NULL,
    "reportId" INTEGER NOT NULL,

    CONSTRAINT "CrucibleReport_pkey" PRIMARY KEY ("reportId","crucibleId")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrucibleReport_reportId_key" ON "CrucibleReport"("reportId");

-- CreateIndex
CREATE INDEX "CrucibleReport_crucibleId_idx" ON "CrucibleReport" USING HASH ("crucibleId");

-- AddForeignKey
ALTER TABLE "CrucibleReport" ADD CONSTRAINT "CrucibleReport_crucibleId_fkey" FOREIGN KEY ("crucibleId") REFERENCES "Crucible"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrucibleReport" ADD CONSTRAINT "CrucibleReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
