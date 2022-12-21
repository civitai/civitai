-- AlterEnum
BEGIN;
DROP VIEW "ModelReportStat";
CREATE TYPE "ReportReason_new" AS ENUM ('TOSViolation', 'NSFW', 'Ownership', 'AdminAttention', 'Claim');
ALTER TABLE "CommentReport" ALTER COLUMN "reason" TYPE "ReportReason_new" USING ("reason"::text::"ReportReason_new");
ALTER TABLE "ReviewReport" ALTER COLUMN "reason" TYPE "ReportReason_new" USING ("reason"::text::"ReportReason_new");
ALTER TABLE "ModelReport" ALTER COLUMN "reason" TYPE "ReportReason_new" USING ("reason"::text::"ReportReason_new");
ALTER TYPE "ReportReason" RENAME TO "ReportReason_old";
ALTER TYPE "ReportReason_new" RENAME TO "ReportReason";
DROP TYPE "ReportReason_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "CommentReport" DROP CONSTRAINT "CommentReport_commentId_fkey";

-- DropForeignKey
ALTER TABLE "CommentReport" DROP CONSTRAINT "CommentReport_userId_fkey";

-- DropForeignKey
ALTER TABLE "ModelReport" DROP CONSTRAINT "ModelReport_modelId_fkey";

-- DropForeignKey
ALTER TABLE "ModelReport" DROP CONSTRAINT "ModelReport_userId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewReport" DROP CONSTRAINT "ReviewReport_reviewId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewReport" DROP CONSTRAINT "ReviewReport_userId_fkey";

-- CreateTable
CREATE TABLE "Report" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "reason" "ReportReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB,
    "status" "ReportStatus" NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- Comment Report
INSERT INTO "Report" ("userId", "reason", "createdAt", "details", "status")
SELECT "userId", "reason", "createdAt", JSONB_BUILD_OBJECT('commentId', "commentId"), 'Valid'
FROM "CommentReport";

-- Model Report
INSERT INTO "Report" ("userId", "reason", "createdAt", "details", "status")
SELECT "userId", "reason", "createdAt", COALESCE("details",jsonb_build_object()) || JSONB_BUILD_OBJECT('modelId', "modelId"), "status"
FROM "ModelReport";

-- Review Report
INSERT INTO "Report" ("userId", "reason", "createdAt", "details", "status")
SELECT "userId", "reason", "createdAt", JSONB_BUILD_OBJECT('reviewId', "reviewId"), 'Valid'
FROM "ReviewReport";

-- AlterTable
DELETE FROM "CommentReport";
ALTER TABLE "CommentReport" DROP CONSTRAINT "CommentReport_pkey",
DROP COLUMN "createdAt",
DROP COLUMN "id",
DROP COLUMN "reason",
DROP COLUMN "userId",
ADD COLUMN     "reportId" INTEGER NOT NULL,
ADD CONSTRAINT "CommentReport_pkey" PRIMARY KEY ("reportId", "commentId");

INSERT INTO "CommentReport" ("commentId", "reportId")
SELECT cast(details->'commentId' as int), id
FROM "Report"
WHERE details->'commentId' IS NOT NULL;

-- AlterTable
DELETE FROM "ModelReport";
ALTER TABLE "ModelReport" DROP CONSTRAINT "ModelReport_pkey",
DROP COLUMN "createdAt",
DROP COLUMN "details",
DROP COLUMN "id",
DROP COLUMN "reason",
DROP COLUMN "reviewedAt",
DROP COLUMN "status",
DROP COLUMN "userId",
ADD COLUMN     "reportId" INTEGER NOT NULL,
ADD CONSTRAINT "ModelReport_pkey" PRIMARY KEY ("reportId", "modelId");

INSERT INTO "ModelReport" ("modelId", "reportId")
SELECT cast(details->'modelId' as int), id
FROM "Report"
WHERE details->'modelId' IS NOT NULL;

-- AlterTable
DELETE FROM "ReviewReport";
ALTER TABLE "ReviewReport" DROP CONSTRAINT "ReviewReport_pkey",
DROP COLUMN "createdAt",
DROP COLUMN "id",
DROP COLUMN "reason",
DROP COLUMN "userId",
ADD COLUMN     "reportId" INTEGER NOT NULL,
ADD CONSTRAINT "ReviewReport_pkey" PRIMARY KEY ("reportId", "reviewId");

INSERT INTO "ReviewReport" ("reviewId", "reportId")
SELECT cast(details->'reviewId' as int), id
FROM "Report"
WHERE details->'reviewId' IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "CommentReport_reportId_key" ON "CommentReport"("reportId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelReport_reportId_key" ON "ModelReport"("reportId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewReport_reportId_key" ON "ReviewReport"("reportId");

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelReport" ADD CONSTRAINT "ModelReport_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelReport" ADD CONSTRAINT "ModelReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewReport" ADD CONSTRAINT "ReviewReport_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewReport" ADD CONSTRAINT "ReviewReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentReport" ADD CONSTRAINT "CommentReport_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentReport" ADD CONSTRAINT "CommentReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rebuild view
CREATE OR REPLACE VIEW "ModelReportStat" AS
SELECT
  m.id "modelId",
  SUM(IIF("reason" = 'TOSViolation' AND r.status = 'Pending', 1, 0)) "tosViolationPending",
	SUM(IIF("reason" = 'TOSViolation' AND r.status = 'Valid', 1, 0)) "tosViolationValid",
	SUM(IIF("reason" = 'TOSViolation' AND r.status = 'Invalid', 1, 0)) "tosViolationInvalid",
	SUM(IIF("reason" = 'NSFW' AND r.status = 'Pending', 1, 0)) "nsfwPending",
	SUM(IIF("reason" = 'NSFW' AND r.status = 'Valid', 1, 0)) "nsfwValid",
	SUM(IIF("reason" = 'NSFW' AND r.status = 'Invalid', 1, 0)) "nsfwInvalid",
	SUM(IIF("reason" = 'Ownership' AND r.status = 'Pending', 1, 0)) "ownershipPending",
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
JOIN "Report" r ON r."id" = mr."reportId"
GROUP BY m.id;