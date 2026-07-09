-- CreateTable
CREATE TABLE "CommentV2Report" (
    "commentV2Id" INTEGER NOT NULL,
    "reportId" INTEGER NOT NULL,

    CONSTRAINT "CommentV2Report_pkey" PRIMARY KEY ("reportId","commentV2Id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommentV2Report_reportId_key" ON "CommentV2Report"("reportId");

-- AddForeignKey
ALTER TABLE "CommentV2Report" ADD CONSTRAINT "CommentV2Report_commentV2Id_fkey" FOREIGN KEY ("commentV2Id") REFERENCES "CommentV2"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentV2Report" ADD CONSTRAINT "CommentV2Report_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
