-- Idempotent: applied by hand, possibly more than once.
--
-- Moderator takedown of a Creator Services offering, and reports against one.
-- The removal columns are set only when a moderator removes an offering, so they are null on a
-- seller's own remove; status Removed alone does not say who removed it. The reason is a key of a
-- fixed list in code. Nullable columns and a new table only: harmless ahead of or behind the deploy.

ALTER TABLE "ServiceOffering" ADD COLUMN IF NOT EXISTS "removedReason" TEXT;
ALTER TABLE "ServiceOffering" ADD COLUMN IF NOT EXISTS "removedDetails" TEXT;
ALTER TABLE "ServiceOffering" ADD COLUMN IF NOT EXISTS "removedAt" TIMESTAMP(3);
ALTER TABLE "ServiceOffering" ADD COLUMN IF NOT EXISTS "removedById" INTEGER;

DO $$
BEGIN
  -- A moderator removal is always a Removed offering with its time and moderator recorded.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceOffering_removed_by_moderator') THEN
    ALTER TABLE "ServiceOffering" ADD CONSTRAINT "ServiceOffering_removed_by_moderator"
      CHECK (
        "removedReason" IS NULL
        OR (
          "status" = 'Removed'::"ServiceOfferingStatus"
          AND "removedAt" IS NOT NULL
          AND "removedById" IS NOT NULL
        )
      );
  END IF;
END $$;

-- Reports: the join row a report of an offering lives in, as for every other report type.
CREATE TABLE IF NOT EXISTS "ServiceOfferingReport" (
    "serviceOfferingId" INTEGER NOT NULL,
    "reportId" INTEGER NOT NULL,

    CONSTRAINT "ServiceOfferingReport_pkey" PRIMARY KEY ("reportId","serviceOfferingId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ServiceOfferingReport_reportId_key" ON "ServiceOfferingReport"("reportId");

CREATE INDEX IF NOT EXISTS "ServiceOfferingReport_serviceOfferingId_idx" ON "ServiceOfferingReport" USING HASH ("serviceOfferingId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceOfferingReport_serviceOfferingId_fkey') THEN
    ALTER TABLE "ServiceOfferingReport" ADD CONSTRAINT "ServiceOfferingReport_serviceOfferingId_fkey"
      FOREIGN KEY ("serviceOfferingId") REFERENCES "ServiceOffering"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceOfferingReport_reportId_fkey') THEN
    ALTER TABLE "ServiceOfferingReport" ADD CONSTRAINT "ServiceOfferingReport_reportId_fkey"
      FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
