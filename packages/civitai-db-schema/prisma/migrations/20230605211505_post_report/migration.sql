-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "tosViolation" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PostReport" (
    "postId" INTEGER NOT NULL,
    "reportId" INTEGER NOT NULL,

    CONSTRAINT "PostReport_pkey" PRIMARY KEY ("reportId","postId")
);

-- CreateIndex
CREATE UNIQUE INDEX "PostReport_reportId_key" ON "PostReport"("reportId");

-- AddForeignKey
ALTER TABLE "PostReport" ADD CONSTRAINT "PostReport_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostReport" ADD CONSTRAINT "PostReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
