-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "alsoReportedBy" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "previouslyReviewedCount" INTEGER NOT NULL DEFAULT 0;
