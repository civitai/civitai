-- M3b. Buyer reviews of completed deals, and the offering counters they feed. Additive only.
-- Applied by hand after M3a and before the P3 PR merges: the code selects these columns. Safe to
-- re-run. Small tables, no backfill; the ALTERs on ServiceDeal and ServiceOffering add defaulted
-- columns, which is metadata-only on PG 11+.

DO $$ BEGIN
  CREATE TYPE "ServiceDealReviewVerdict" AS ENUM ('Happy', 'NotQuite');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "ServiceDeal" ADD COLUMN IF NOT EXISTS "reviewEnabledAt" TIMESTAMP(3);

ALTER TABLE "ServiceOffering"
  ADD COLUMN IF NOT EXISTS "allowReviewWork" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "happyCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "reviewCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "happySortKey" DOUBLE PRECISION NOT NULL DEFAULT -1;

CREATE TABLE IF NOT EXISTS "ServiceDealReview" (
  "id" SERIAL PRIMARY KEY,
  "dealId" INTEGER NOT NULL REFERENCES "ServiceDeal"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "offeringId" INTEGER NOT NULL REFERENCES "ServiceOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "sellerId" INTEGER NOT NULL,
  "buyerId" INTEGER NOT NULL,
  "verdict" "ServiceDealReviewVerdict" NOT NULL,
  "comment" TEXT,
  "scanStatus" "ServiceOfferingIngestionStatus" NOT NULL DEFAULT 'Pending',
  "scanWorkflowId" TEXT,
  "publishedAt" TIMESTAMP(3),
  "editableUntil" TIMESTAMP(3) NOT NULL,
  "sellerReply" TEXT,
  "sellerReplyAt" TIMESTAMP(3),
  "sellerReplyScanStatus" "ServiceOfferingIngestionStatus",
  "sellerReplyScanWorkflowId" TEXT,
  "hiddenAt" TIMESTAMP(3),
  "hiddenById" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "ServiceDealReview_dealId_key" ON "ServiceDealReview"("dealId");
CREATE INDEX IF NOT EXISTS "ServiceDealReview_offeringId_publishedAt_idx" ON "ServiceDealReview"("offeringId", "publishedAt");
CREATE INDEX IF NOT EXISTS "ServiceDealReview_sellerId_publishedAt_idx" ON "ServiceDealReview"("sellerId", "publishedAt");

CREATE TABLE IF NOT EXISTS "ServiceDealReviewImage" (
  "reviewId" INTEGER NOT NULL REFERENCES "ServiceDealReview"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "imageId" INTEGER NOT NULL REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY ("reviewId", "imageId")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ServiceDealReviewImage_imageId_key" ON "ServiceDealReviewImage"("imageId");

-- The final each image was copied from: one copy per final per review, and the takedown list says
-- which delivered file an image came from.
ALTER TABLE "ServiceDealReviewImage" ADD COLUMN IF NOT EXISTS "sourceFileId" INTEGER;
DO $$ BEGIN
  ALTER TABLE "ServiceDealReviewImage" ADD CONSTRAINT "ServiceDealReviewImage_sourceFileId_fkey"
    FOREIGN KEY ("sourceFileId") REFERENCES "ServiceDealFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "ServiceDealReviewImage_reviewId_sourceFileId_key"
  ON "ServiceDealReviewImage"("reviewId", "sourceFileId");
