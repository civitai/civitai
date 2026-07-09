-- Backfill ModelVersion.baseModel for HiDream-O1 LoRAs created via the
-- training pipeline. src/utils/training.ts had `baseModel: 'HiDream O1'`
-- (with a space) which doesn't match the canonical ecosystem key
-- `HiDream-O1` from basemodel.constants.ts. stringifyAIR's try/catch over
-- getRootEcosystem() silently kept the bad string, lowercased it, and
-- emitted `urn:air:hidream o1:lora:civitai:...` to the orchestrator. AIR
-- segments are colon-separated and don't allow spaces; the orchestrator's
-- URN parser falls back to `unknown:unknown:...` and the scan workflow
-- fails with HTTP 400 (`Resource ... does not exist or is not valid.`).
-- This affected 100% of HiDream-O1 scan submissions since the ecosystem
-- shipped on 2026-05-13. Fix the code in src/utils/training.ts and the
-- already-persisted rows here. The scan-files-fallback job (5 min cadence)
-- will pick up the affected ModelFile rows on its next tick and resubmit
-- with the corrected baseModel; no explicit scanRequestedAt reset needed
-- because that job already resets it after every transient failure.
UPDATE "ModelVersion"
SET "baseModel" = 'HiDream-O1'
WHERE "baseModel" = 'HiDream O1';
