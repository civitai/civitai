-- AlterEnum
BEGIN;
ALTER TYPE "ReportStatus" ADD VALUE 'Processing';
COMMIT;

-- DropForeignKey
ALTER TABLE "CommentReport" DROP CONSTRAINT "CommentReport_commentId_fkey";

-- DropForeignKey
ALTER TABLE "CommentReport" DROP CONSTRAINT "CommentReport_reportId_fkey";

-- DropForeignKey
ALTER TABLE "ModelReport" DROP CONSTRAINT "ModelReport_modelId_fkey";

-- DropForeignKey
ALTER TABLE "ModelReport" DROP CONSTRAINT "ModelReport_reportId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewReport" DROP CONSTRAINT "ReviewReport_reportId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewReport" DROP CONSTRAINT "ReviewReport_reviewId_fkey";

-- AddForeignKey
ALTER TABLE "ModelReport" ADD CONSTRAINT "ModelReport_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelReport" ADD CONSTRAINT "ModelReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewReport" ADD CONSTRAINT "ReviewReport_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewReport" ADD CONSTRAINT "ReviewReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentReport" ADD CONSTRAINT "CommentReport_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentReport" ADD CONSTRAINT "CommentReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Update stats report
DROP VIEW "ModelReportStat";
CREATE VIEW "ModelReportStat" AS
SELECT
  m.id "modelId",
  SUM(IIF("reason" = 'TOSViolation' AND r.status = 'Pending', 1, 0)) "tosViolationPending",
	SUM(IIF("reason" = 'TOSViolation' AND r.status = 'Valid', 1, 0)) "tosViolationValid",
	SUM(IIF("reason" = 'TOSViolation' AND r.status = 'Invalid', 1, 0)) "tosViolationInvalid",
	SUM(IIF("reason" = 'NSFW' AND r.status = 'Pending', 1, 0)) "nsfwPending",
	SUM(IIF("reason" = 'NSFW' AND r.status = 'Valid', 1, 0)) "nsfwValid",
	SUM(IIF("reason" = 'NSFW' AND r.status = 'Invalid', 1, 0)) "nsfwInvalid",
	SUM(IIF("reason" = 'Ownership' AND r.status = 'Pending', 1, 0)) "ownershipPending",
	SUM(IIF("reason" = 'Ownership' AND r.status = 'Processing', 1, 0)) "ownershipProcessing",
	SUM(IIF("reason" = 'Ownership' AND r.status = 'Valid', 1, 0)) "ownershipValid",
	SUM(IIF("reason" = 'Ownership' AND r.status = 'Invalid', 1, 0)) "ownershipInvalid",
	SUM(IIF("reason" = 'AdminAttention' AND r.status = 'Pending', 1, 0)) "adminAttentionPending",
	SUM(IIF("reason" = 'AdminAttention' AND r.status = 'Valid', 1, 0)) "adminAttentionValid",
	SUM(IIF("reason" = 'AdminAttention' AND r.status = 'Invalid', 1, 0)) "adminAttentionInvalid",
	SUM(IIF("reason" = 'Claim' AND r.status = 'Pending', 1, 0)) "claimPending",
	SUM(IIF("reason" = 'Claim' AND r.status = 'Valid', 1, 0)) "claimValid",
	SUM(IIF("reason" = 'Claim' AND r.status = 'Invalid', 1, 0)) "claimInvalid"
FROM "Model" m
LEFT JOIN "ModelReport" mr ON mr."modelId" = m.id
LEFT JOIN "Report" r ON r.id = mr."reportId"
GROUP BY m.id;
