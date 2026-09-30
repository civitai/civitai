-- Crucible text moderation: scan state for the name + description, as user challenges have.
--
-- Applied MANUALLY (no `prisma migrate deploy`), BEFORE the code that reads these columns deploys.
-- "CrucibleIngestionStatus" is a brand-new type, so creating and using it here is safe.

CREATE TYPE "CrucibleIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error');

-- Defaults keep existing crucibles visible without a backfill; the create path sets 'Pending'.
ALTER TABLE "Crucible"
  ADD COLUMN "ingestion" "CrucibleIngestionStatus" NOT NULL DEFAULT 'Scanned',
  ADD COLUMN "scannedAt" TIMESTAMP(3),
  ADD COLUMN "textNsfw"  BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Crucible_status_ingestion_idx" ON "Crucible" ("status", "ingestion");
