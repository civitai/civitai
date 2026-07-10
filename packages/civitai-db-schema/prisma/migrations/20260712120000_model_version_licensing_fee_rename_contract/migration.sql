-- A2 — fractional licensing fee, RENAME-CONTRACT (phase 4 — final step).
--
-- Drops the rename sync trigger + function and the now-unused "licensingFeeAmount" column. After phase 3a
-- (rename-expand) is 100% rolled out, all code reads/writes "licensingFee" and nothing references
-- "licensingFeeAmount" (verified repo-wide). This completes the migration: the end state is a single
-- "licensingFee" DECIMAL(10,2) column, no @map, matching the Prisma field name — code and DB agree.
--
-- Run ONLY after phase 3a is fully rolled out (no pod still reads/writes "licensingFeeAmount"). Confirm no
-- ClickPipe/CDC consumer depends on "licensingFeeAmount". Migration-only — no code change or client regen.
--
-- Irreversible ("licensingFeeAmount" is gone). Applied manually per repo convention; idempotent.

DROP TRIGGER IF EXISTS "modelVersionLicensingFeeRenameSync" ON "ModelVersion";
DROP FUNCTION IF EXISTS "syncModelVersionLicensingFeeRename"();

-- DROP COLUMN takes a brief ACCESS EXCLUSIVE lock on the hot "ModelVersion" table; fail fast rather than queue
-- every query behind it, and just re-run if it times out.
SET lock_timeout = '5s';
ALTER TABLE "ModelVersion" DROP COLUMN IF EXISTS "licensingFeeAmount";
