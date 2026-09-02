-- Adds the SSHS_12 hash type: left(sshs_model_hash, 12) from a safetensors header.
--
-- SAFE TO APPLY BEFORE THE DEPLOY, and that is the intended order.
--   1. Apply this. The value exists; nothing writes it, because no shipped build knows it yet.
--   2. Deploy. New scans start writing the row as files are scanned.
--   3. Backfill the existing corpus, so already-scanned files get the row too. The value is in
--      ModelFile.headerData, so that needs no file access — but the tooling for it is NOT in this
--      commit, and until it lands only newly-scanned files carry SSHS_12.
--
-- WHY THIS ORDER AND NOT THE REVERSE. ModelHashType is Prisma-mapped and the ModelHash view has no
-- type filter, so a row carrying a label the running client cannot decode throws on READ for every
-- consumer of that view — the 2026-08-19 SHA256_12 incident. Adding the label creates no rows, so
-- it cannot cause that. Deploying first is what would: a scan completing before the ALTER lands
-- would try to write 'SSHS_12' into a type that has no such value and lose the file's hash rows.
--
-- The backfill is the step that must wait for the rollout to finish: it is the only one that
-- writes rows in bulk, which is exactly what turned the 2026-08-19 ordering mistake into an outage.

ALTER TYPE "ModelHashType" ADD VALUE IF NOT EXISTS 'SSHS_12';
