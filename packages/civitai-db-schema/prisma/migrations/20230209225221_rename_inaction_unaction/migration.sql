/*
  Warnings:

  - The values [Inactioned] on the enum `ReportStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;


DROP VIEW "ModelReportStat";


CREATE TYPE "ReportStatus_new" AS ENUM ('Pending', 'Processing', 'Actioned', 'Unactioned');


ALTER TABLE "Report" ADD COLUMN "status_new" "ReportStatus_new";


UPDATE "Report"
SET "status_new" = 'Actioned'
WHERE "status" = 'Actioned';


UPDATE "Report"
SET "status_new" = 'Unactioned'
WHERE "status" = 'Inactioned';


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

-- Rebuild view

CREATE OR REPLACE VIEW "ModelReportStat" AS
SELECT m.id "modelId",
       SUM(IIF("reason" = 'TOSViolation'
               AND r.status = 'Pending', 1, 0)) "tosViolationPending",
       SUM(IIF("reason" = 'TOSViolation'
               AND r.status = 'Actioned', 1, 0)) "tosViolationActioned",
       SUM(IIF("reason" = 'TOSViolation'
               AND r.status = 'Unactioned', 1, 0)) "tosViolationUnactioned",
       SUM(IIF("reason" = 'NSFW'
               AND r.status = 'Pending', 1, 0)) "nsfwPending",
       SUM(IIF("reason" = 'NSFW'
               AND r.status = 'Actioned', 1, 0)) "nsfwActioned",
       SUM(IIF("reason" = 'NSFW'
               AND r.status = 'Unactioned', 1, 0)) "nsfwUnactioned",
       SUM(IIF("reason" = 'Ownership'
               AND r.status = 'Pending', 1, 0)) "ownershipPending",
       SUM(IIF("reason" = 'Ownership'
               AND r.status = 'Processing', 1, 0)) "ownershipProcessing",
       SUM(IIF("reason" = 'Ownership'
               AND r.status = 'Actioned', 1, 0)) "ownershipActioned",
       SUM(IIF("reason" = 'Ownership'
               AND r.status = 'Unactioned', 1, 0)) "ownershipUnactioned",
       SUM(IIF("reason" = 'AdminAttention'
               AND r.status = 'Pending', 1, 0)) "adminAttentionPending",
       SUM(IIF("reason" = 'AdminAttention'
               AND r.status = 'Actioned', 1, 0)) "adminAttentionActioned",
       SUM(IIF("reason" = 'AdminAttention'
               AND r.status = 'Unactioned', 1, 0)) "adminAttentionUnactioned",
       SUM(IIF("reason" = 'Claim'
               AND r.status = 'Pending', 1, 0)) "claimPending",
       SUM(IIF("reason" = 'Claim'
               AND r.status = 'Actioned', 1, 0)) "claimActioned",
       SUM(IIF("reason" = 'Claim'
               AND r.status = 'Unactioned', 1, 0)) "claimUnactioned"
FROM "Model" m
LEFT JOIN "ModelReport" mr ON mr."modelId" = m.id
JOIN "Report" r ON r."id" = mr."reportId"
GROUP BY m.id;

