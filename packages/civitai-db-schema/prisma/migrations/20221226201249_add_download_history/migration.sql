-- AlterTable
ALTER TABLE "ModelFile" ALTER COLUMN "type" SET DEFAULT 'Model';

-- AlterTable
ALTER TABLE "UserActivity" ADD COLUMN     "hide" BOOLEAN NOT NULL DEFAULT false;

-- Add View
CREATE VIEW "DownloadHistory" AS
SELECT
  ua.id,
  ua."userId",
  mv.id "modelVersionId",
  mv."modelId",
  ua."createdAt"
FROM "UserActivity" ua
JOIN "ModelVersion" mv ON mv.id = CAST(ua.details->>'modelVersionId' as int)
WHERE
  ua.activity = 'ModelDownload'
AND ua."userId" IS NOT NULL
AND ua.hide = FALSE
ORDER BY ua."createdAt" DESC;