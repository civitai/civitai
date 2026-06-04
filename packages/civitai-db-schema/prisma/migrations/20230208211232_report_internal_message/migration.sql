/*
  Warnings:

  - The values [Valid,Invalid] on the enum `ReportStatus` will be removed. If these variants are still used in the database, this will fail.

*/ -- AlterEnum
BEGIN;


DROP VIEW "ModelReportStat";


CREATE TYPE "ReportStatus_new" AS ENUM ('Pending', 'Processing', 'Actioned', 'Inactioned');


ALTER TABLE "Report" ADD COLUMN "status_new" "ReportStatus_new";


UPDATE "Report"
SET "status_new" = 'Actioned'
WHERE "status" = 'Valid';


UPDATE "Report"
SET "status_new" = 'Inactioned'
WHERE "status" = 'Invalid';


UPDATE "Report"
SET "status_new" = 'Pending'
WHERE "status" = 'Pending';


UPDATE "Report"
SET "status_new" = 'Processing'
WHERE "status" = 'Processing';


ALTER TABLE "Report"
DROP COLUMN "status";


ALTER TYPE "ReportStatus" RENAME TO "ReportStatus_old";


ALTER TYPE "ReportStatus_new" RENAME TO "ReportStatus";


DROP TYPE "ReportStatus_old";


ALTER TABLE "Report" RENAME COLUMN "status_new" TO "status";


ALTER TABLE "Report"
ALTER COLUMN "status"
SET NOT NULL;


COMMIT;

-- AlterTable

ALTER TABLE "Report" ADD COLUMN "internalNotes" TEXT;

-- CreateIndex

CREATE INDEX "Notification_userId_idx" ON "Notification"("userId");

-- Rebuild view

CREATE OR REPLACE VIEW "ModelReportStat" AS
SELECT m.id "modelId",
       SUM(IIF("reason" = 'TOSViolation'
               AND r.status = 'Pending', 1, 0)) "tosViolationPending",
       SUM(IIF("reason" = 'TOSViolation'
               AND r.status = 'Actioned', 1, 0)) "tosViolationActioned",
       SUM(IIF("reason" = 'TOSViolation'
               AND r.status = 'Inactioned', 1, 0)) "tosViolationInactioned",
       SUM(IIF("reason" = 'NSFW'
               AND r.status = 'Pending', 1, 0)) "nsfwPending",
       SUM(IIF("reason" = 'NSFW'
               AND r.status = 'Actioned', 1, 0)) "nsfwActioned",
       SUM(IIF("reason" = 'NSFW'
               AND r.status = 'Inactioned', 1, 0)) "nsfwInactioned",
       SUM(IIF("reason" = 'Ownership'
               AND r.status = 'Pending', 1, 0)) "ownershipPending",
       SUM(IIF("reason" = 'Ownership'
               AND r.status = 'Processing', 1, 0)) "ownershipProcessing",
       SUM(IIF("reason" = 'Ownership'
               AND r.status = 'Actioned', 1, 0)) "ownershipActioned",
       SUM(IIF("reason" = 'Ownership'
               AND r.status = 'Inactioned', 1, 0)) "ownershipInactioned",
       SUM(IIF("reason" = 'AdminAttention'
               AND r.status = 'Pending', 1, 0)) "adminAttentionPending",
       SUM(IIF("reason" = 'AdminAttention'
               AND r.status = 'Actioned', 1, 0)) "adminAttentionActioned",
       SUM(IIF("reason" = 'AdminAttention'
               AND r.status = 'Inactioned', 1, 0)) "adminAttentionInactioned",
       SUM(IIF("reason" = 'Claim'
               AND r.status = 'Pending', 1, 0)) "claimPending",
       SUM(IIF("reason" = 'Claim'
               AND r.status = 'Actioned', 1, 0)) "claimActioned",
       SUM(IIF("reason" = 'Claim'
               AND r.status = 'Inactioned', 1, 0)) "claimInactioned"
FROM "Model" m
LEFT JOIN "ModelReport" mr ON mr."modelId" = m.id
JOIN "Report" r ON r."id" = mr."reportId"
GROUP BY m.id;

