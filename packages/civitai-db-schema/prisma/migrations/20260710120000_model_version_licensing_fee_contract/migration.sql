-- A2 — fractional licensing fee, CONTRACT phase.
--
-- Run ONLY after the EXPAND release (20260709120000_model_version_licensing_fee_expand) is 100% rolled out —
-- i.e. no old Int-client pods remain anywhere that reads "ModelVersion". Until then the sync trigger must stay.
--
-- Drops the bidirectional sync trigger + function and the legacy INTEGER "licensingFee" column. New code
-- already reads/writes the decimal "licensingFeeAmount" column (the Prisma field `licensingFee` @map's to it),
-- and a repo-wide check confirmed nothing references the physical "licensingFee" column, so this needs no code
-- change or client regeneration.
--
-- Before running, confirm: (1) the expand release is fully rolled out; (2) no logical-replication / ClickPipe
-- CDC consumer of "ModelVersion" depends on the "licensingFee" column (dropping a replicated column emits a
-- schema-change downstream — coordinate with whoever owns the pipe).
--
-- Irreversible (the Int column is gone). Applied manually per repo convention; idempotent (safe to re-run).

DROP TRIGGER IF EXISTS "modelVersionLicensingFeeSync" ON "ModelVersion";
DROP FUNCTION IF EXISTS "syncModelVersionLicensingFee"();

-- DROP COLUMN takes a brief ACCESS EXCLUSIVE lock on the hot "ModelVersion" table. Fail fast rather than let it
-- queue every query behind it if a long-running transaction is holding the table; just re-run if it times out.
SET lock_timeout = '5s';
ALTER TABLE "ModelVersion" DROP COLUMN IF EXISTS "licensingFee";
