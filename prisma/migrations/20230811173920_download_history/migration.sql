-- This migration was manually applied.
-- DropForeignKey
ALTER TABLE "UserActivity" DROP CONSTRAINT "UserActivity_userId_fkey";

-- CreateTable
CREATE TABLE "DownloadHistoryNew" (
    "userId" INTEGER NOT NULL,
    "modelVersionId" INTEGER NOT NULL,
    "downloadAt" TIMESTAMP(3) NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DownloadHistory_pkey" PRIMARY KEY ("userId","modelVersionId")
);

-- Populate data
-- INSERT INTO "DownloadHistoryNew"("userId", "modelVersionId", "downloadAt", "hidden")
-- SELECT
--     "userId",
--     CAST(details->'modelVersionId' as int) as "modelVersionId",
--     "createdAt" AS "downloadAt",
--     "hide" AS "hidden"
-- FROM "UserActivity"
-- WHERE "userId" > 0 AND activity = 'ModelDownload'
-- ORDER BY id DESC
-- ON CONFLICT ("userId", "modelVersionId") DO NOTHING;

-- CreateIndex
CREATE INDEX "DownloadHistory_userId_downloadAt_idx" ON "DownloadHistoryNew"("userId", "downloadAt");

-- AddForeignKey
ALTER TABLE "DownloadHistoryNew" ADD CONSTRAINT "DownloadHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DownloadHistoryNew" ADD CONSTRAINT "DownloadHistory_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Drop old view
DROP VIEW IF EXISTS "DownloadHistory";
ALTER TABLE "DownloadHistoryNew" RENAME TO "DownloadHistory";

-- DropTable
DROP TABLE "UserActivity";

-- DropEnum
DROP TYPE "UserActivityType";
