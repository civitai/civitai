-- Service offerings: the title and description go through the text content check, the rating is
-- set by the system (the seller's pick moves to "declaredNsfwLevel"), and the cover image is a real
-- relation. Apply BEFORE the deploy that reads these columns. Existing offerings start Pending and
-- are submitted by the `service-offering-ingestion-reconcile` job once that deploy is live.
-- "declaredNsfwLevel" starts null: until the deploy the seller's pick is still written to
-- "maxNsfwLevel", and the first recompute after the deploy copies it from there.

CREATE TYPE "ServiceOfferingIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error');

ALTER TABLE "ServiceOffering"
  ADD COLUMN "declaredNsfwLevel" INTEGER,
  ADD COLUMN "ingestion" "ServiceOfferingIngestionStatus" NOT NULL DEFAULT 'Pending',
  ADD COLUMN "scanWorkflowId" TEXT,
  ADD COLUMN "scannedAt" TIMESTAMP(3);

-- Nothing has written coverImageId so far; clear any id that names no image so the key can be added.
UPDATE "ServiceOffering" o SET "coverImageId" = NULL
WHERE o."coverImageId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Image" i WHERE i.id = o."coverImageId");

ALTER TABLE "ServiceOffering"
  ADD CONSTRAINT "ServiceOffering_coverImageId_fkey" FOREIGN KEY ("coverImageId")
  REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "ServiceOffering_coverImageId_idx" ON "ServiceOffering" ("coverImageId");
