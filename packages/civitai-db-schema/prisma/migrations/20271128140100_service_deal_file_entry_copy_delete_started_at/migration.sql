-- Set just before the scan-copy cleanup deletes an entry's copy, so a retry can tell its own delete
-- from one made elsewhere. Nullable, no backfill.
ALTER TABLE "ServiceDealFileEntry" ADD COLUMN IF NOT EXISTS "copyDeleteStartedAt" TIMESTAMP(3);
