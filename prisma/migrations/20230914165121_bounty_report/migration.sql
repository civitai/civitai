-- CreateTable
CREATE TABLE "BountyReport" (
    "bountyId" INTEGER NOT NULL,
    "reportId" INTEGER NOT NULL,

    CONSTRAINT "BountyReport_pkey" PRIMARY KEY ("reportId","bountyId")
);

-- CreateTable
CREATE TABLE "BountyEntryReport" (
    "bountyEntryId" INTEGER NOT NULL,
    "reportId" INTEGER NOT NULL,

    CONSTRAINT "BountyEntryReport_pkey" PRIMARY KEY ("reportId","bountyEntryId")
);

-- CreateIndex
CREATE UNIQUE INDEX "BountyReport_reportId_key" ON "BountyReport"("reportId");

-- CreateIndex
CREATE UNIQUE INDEX "BountyEntryReport_reportId_key" ON "BountyEntryReport"("reportId");

-- AddForeignKey
ALTER TABLE "BountyReport" ADD CONSTRAINT "BountyReport_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyReport" ADD CONSTRAINT "BountyReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyEntryReport" ADD CONSTRAINT "BountyEntryReport_bountyEntryId_fkey" FOREIGN KEY ("bountyEntryId") REFERENCES "BountyEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyEntryReport" ADD CONSTRAINT "BountyEntryReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
