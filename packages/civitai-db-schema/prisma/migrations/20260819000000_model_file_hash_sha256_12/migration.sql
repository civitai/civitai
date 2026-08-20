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
-- The backfill is `GET /api/admin/temp/backfill-sha256-12` — token-gated, dry-run by default,
-- batched, resumable via `start=<lastCursor>`, idempotent via ON CONFLICT ("fileId", type) DO
-- NOTHING. It derives from the stored SHA256 row THROUGH normalizeScanHashes() rather than
-- truncating inline, so it inherits the all-zero "file unreachable" sentinel guard; deriving from
-- that sentinel would give every unreachable file the same 12-char hash. See
-- docs/image-resource-hash-matching.md for the parameters and the resume loop.
--
-- 🔴 Production was already backfilled OUT-OF-BAND on 2026-08-19/20, before that endpoint existed.
-- Measured on the nvme0 replica 2026-08-20: 1,489,372 SHA256_12 rows against 1,489,384 SHA256
-- rows, all 12 chars, none disagreeing with left(sha256,12), every one created between 22:15Z and
-- 02:29Z. The anti-join leaves 15 files short. Re-run that anti-join (in the doc) before planning
-- a run — do not assume a corpus-wide job is still outstanding.
