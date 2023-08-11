-- DropForeignKey
ALTER TABLE "UserActivity" DROP CONSTRAINT "UserActivity_userId_fkey";

-- Drop old view
DROP VIEW "DownloadHistory";

-- CreateTable
CREATE TABLE "DownloadHistory" (
    "userId" INTEGER NOT NULL,
    "modelVersionId" INTEGER NOT NULL,
    "downloadAt" TIMESTAMP(3) NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DownloadHistory_pkey" PRIMARY KEY ("userId","modelVersionId")
);

-- Populate data
INSERT INTO "DownloadHistory" ("userId", "modelVersionId", "downloadAt", "hidden")
SELECT "userId", "modelVersionId", MAX("downloadAt"), MAX(hidden)
FROM (
    SELECT
        "userId",
        (details ->> 'modelVersionId')::integer as "modelVersionId",
        "createdAt" AS "downloadAt",
        "hide" AS "hidden"
    FROM "UserActivity"
    WHERE "userId" > 0 AND activity = 'ModelDownload'
) d
WHERE "modelVersionId" IS NOT NULL
GROUP BY "userId", "modelVersionId";

-- CreateIndex
CREATE INDEX "DownloadHistory_userId_downloadAt_idx" ON "DownloadHistory"("userId", "downloadAt");

-- AddForeignKey
ALTER TABLE "DownloadHistory" ADD CONSTRAINT "DownloadHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DownloadHistory" ADD CONSTRAINT "DownloadHistory_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DownloadHistory" ADD CONSTRAINT "DownloadHistory_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DropTable
DROP TABLE "UserActivity";

-- DropEnum
DROP TYPE "UserActivityType";