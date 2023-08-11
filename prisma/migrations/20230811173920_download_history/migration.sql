-- DropForeignKey
ALTER TABLE "UserActivity" DROP CONSTRAINT "UserActivity_userId_fkey";


-- DropTable
DROP TABLE "UserActivity";

-- DropEnum
DROP TYPE "UserActivityType";

-- CreateTable
CREATE TABLE "DownloadHistory" (
    "userId" INTEGER NOT NULL,
    "modelVersionId" INTEGER NOT NULL,
    "downloadAt" TIMESTAMP(3) NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "modelId" INTEGER,

    CONSTRAINT "DownloadHistory_pkey" PRIMARY KEY ("userId","modelVersionId")
);

-- CreateIndex
CREATE INDEX "DownloadHistory_downloadAt_idx" ON "DownloadHistory"("downloadAt");

-- AddForeignKey
ALTER TABLE "DownloadHistory" ADD CONSTRAINT "DownloadHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DownloadHistory" ADD CONSTRAINT "DownloadHistory_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DownloadHistory" ADD CONSTRAINT "DownloadHistory_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE SET NULL ON UPDATE CASCADE;
