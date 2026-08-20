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
-- it, and this is ~1.5M rows.
--
-- 🔴 THE BACKFILL IS NOT IMPLEMENTED. This comment (and docs/image-resource-hash-matching.md)
-- used to describe a `GET /api/admin/temp/backfill-sha256-12` endpoint. That file has never
-- existed on any branch — `git log --diff-filter=A -- src/pages/api/admin/temp/backfill-sha256-12.ts`
-- returns nothing. Anyone following the old instruction gets a 404, not a backfill.
--
-- Consequence, and it is not a broken state: files scanned AFTER the release that ships
-- normalizeScanHashes() get their SHA256_12 row from the scan path. Files scanned BEFORE it keep
-- failing 12-char LoRA detection exactly as they do today, indefinitely, until someone either
-- writes the backfill or replays them through /api/mod/reprocess-scan.
