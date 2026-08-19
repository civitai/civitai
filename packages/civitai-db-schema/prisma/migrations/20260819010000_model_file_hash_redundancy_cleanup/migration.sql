-- Post-deploy cleanup for ModelFileHash. Both statements remove something the application no
-- longer needs, and BOTH require the release containing these changes to be live first:
--
--   * src/server/controllers/model.controller.ts — getModelByHashesHandler now matches with
--     `hash = ANY(ARRAY[...]::citext[])` instead of wrapping the column in LOWER()
--   * src/server/services/model-file-scan.service.ts — normalizeScanHashes() truncates AutoV3
--     in the scan webhook path, which is what the trigger below used to do
--
-- 🔴 Do not apply either statement before that release is in production.
--
-- CONCURRENTLY cannot run inside a transaction block, so run these as separate statements.

-- ---------------------------------------------------------------------------
-- 1. Drop the index on lower(hash)
-- ---------------------------------------------------------------------------
-- "hash" is citext, so equality is already case-insensitive and modelFileHash_hash_cs serves
-- the same lookups natively. Measured on prod before dropping:
--
--   ModelFileHash_pkey     986,035,442 scans   365 MB
--   modelFileHash_hash_cs   31,375,882 scans   619 MB
--   modelfilehash_hash             849 scans   577 MB   <- this one
--
-- Those 849 scans came from getModelByHashesHandler alone. It now uses the citext form, which
-- is both correct and faster (index-scan node: 10.309 ms -> 0.779 ms on a 50-hash probe,
-- identical rows). Dropping this before that deploy sends the handler to a sequential scan
-- over ~8.75M rows.

DROP INDEX CONCURRENTLY IF EXISTS "modelfilehash_hash";

-- ---------------------------------------------------------------------------
-- 2. Drop the AutoV3 truncation trigger
-- ---------------------------------------------------------------------------
-- The orchestrator sends AutoV3 full-length ("SHA256 of the file with safetensors header
-- metadata stripped", per @civitai/client); we store 12 chars. This trigger did that rewrite.
-- normalizeScanHashes() now does it in the scan webhook path instead, so the trigger is a
-- no-op — the two produce identical values, which is why they could coexist across the deploy.
--
-- Safe because every writer of ModelFileHash is accounted for. Enumerated from source, and
-- pinned by src/server/services/__tests__/model-file-hash-writers.test.ts, which fails when the
-- set grows OR shrinks:
--   applyScanOutcome                              -> normalizeScanHashes
--   /api/mod/reprocess-scan                       -> normalizeScanHashes
--   createModelFileScanRequest's dev-only skip    -> writes the all-zero SHA256 "file
--     (orchestrator.service.ts)                      unreachable" sentinel only, never AutoV3
--
-- (An earlier draft of this comment also listed an `admin/temp/backfill-sha256-12` writer. No
-- such endpoint exists in the repo — see the note in the 20260819000000 migration.)
--
-- A future writer that inserts AutoV3 without normalizing would store 64 chars and silently
-- break matching for the type carrying ~85-88% of LoRA references. normalizeScanHashes() is the
-- single place that guards this now; keep new writers going through it.
--
-- lock_timeout because DROP TRIGGER takes ACCESS EXCLUSIVE on a table that is read constantly
-- (986M lifetime PK scans) — better to fail fast and retry than to queue every reader behind it.
SET lock_timeout = '5s';

DROP TRIGGER IF EXISTS truncate_autov3_hash_on_insert ON "ModelFileHash";
DROP FUNCTION IF EXISTS truncate_autov3_hash();
