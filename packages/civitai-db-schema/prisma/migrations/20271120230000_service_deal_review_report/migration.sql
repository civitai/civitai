-- Reporting a single buyer review on a service. Additive only: one new table, no enum value. Apply it
-- BEFORE the code that writes it deploys. Every step is re-runnable.
SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "ServiceDealReviewReport" (
    "reportId" INTEGER NOT NULL,
    "serviceDealReviewId" INTEGER NOT NULL,
    "serviceOfferingId" INTEGER NOT NULL,

    CONSTRAINT "ServiceDealReviewReport_pkey" PRIMARY KEY ("reportId")
);

CREATE INDEX IF NOT EXISTS "ServiceDealReviewReport_serviceDealReviewId_idx"
  ON "ServiceDealReviewReport" USING HASH ("serviceDealReviewId");
CREATE INDEX IF NOT EXISTS "ServiceDealReviewReport_serviceOfferingId_idx"
  ON "ServiceDealReviewReport" USING HASH ("serviceOfferingId");

-- RESTRICT, not CASCADE, on the review and the offering: a report is moderation evidence (a CSAM one
-- among them), so deleting what it is about fails rather than silently dropping the report's subject.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceDealReviewReport_reportId_fkey') THEN
    ALTER TABLE "ServiceDealReviewReport" ADD CONSTRAINT "ServiceDealReviewReport_reportId_fkey"
      FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceDealReviewReport_serviceDealReviewId_fkey') THEN
    ALTER TABLE "ServiceDealReviewReport" ADD CONSTRAINT "ServiceDealReviewReport_serviceDealReviewId_fkey"
      FOREIGN KEY ("serviceDealReviewId") REFERENCES "ServiceDealReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceDealReviewReport_serviceOfferingId_fkey') THEN
    ALTER TABLE "ServiceDealReviewReport" ADD CONSTRAINT "ServiceDealReviewReport_serviceOfferingId_fkey"
      FOREIGN KEY ("serviceOfferingId") REFERENCES "ServiceOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
