-- CreateTable
CREATE TABLE "ChatReport" (
    "chatId" INTEGER NOT NULL,
    "reportId" INTEGER NOT NULL,

    CONSTRAINT "ChatReport_pkey" PRIMARY KEY ("reportId","chatId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChatReport_reportId_key" ON "ChatReport"("reportId");

-- CreateIndex
CREATE INDEX "ChatReport_chatId_idx" ON "ChatReport" USING HASH ("chatId");

-- AddForeignKey
ALTER TABLE "ChatReport" ADD CONSTRAINT "ChatReport_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatReport" ADD CONSTRAINT "ChatReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
