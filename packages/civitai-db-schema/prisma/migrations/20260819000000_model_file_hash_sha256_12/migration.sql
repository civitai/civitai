-- A1111/Forge write sha256[0:12] into image metadata for LoRAs. AutoV2 is sha256[0:10] and
-- AutoV3 is a different (tensor-only) algorithm, so no stored width matches that value and
-- resource detection silently fails for those uploads. Storing the 12-char prefix lets the
-- existing exact-match join in get_image_resources() resolve it with no change to that function.
--
-- It appears in /api/v1/model-versions responses alongside the other types, the same way
-- AutoV2 (also a sha256 truncation) already does.
--
-- No trigger. The value is produced in the scan webhook path alongside the AutoV3 truncation --
-- see normalizeScanHashes() in src/server/services/model-file-scan.service.ts. This migration
-- only adds the enum value; everything else is application code plus a one-time backfill.

-- AlterEnum
ALTER TYPE "ModelHashType" ADD VALUE IF NOT EXISTS 'SHA256_12';

-- Backfill is NOT run here. ADD VALUE cannot be referenced in the same transaction that adds
-- it, and this is ~1.5M rows. Run it afterwards in one call:
--
--   GET /api/admin/temp/backfill-sha256-12?token=$WEBHOOK_TOKEN                (dry run)
--   GET /api/admin/temp/backfill-sha256-12?token=$WEBHOOK_TOKEN&dryRun=false   (apply)
--
-- It batches internally and logs a resumable cursor to the server console after each batch.
-- Until it completes, detection simply keeps failing for un-backfilled files exactly as it
-- does today — there is no half-broken state.
