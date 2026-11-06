-- Run by hand after migration.sql and BEFORE deploying the code that writes "ModelOwnership", so each
-- model's baseline is its owner before any recorded change. Run it again after the deploy to cover
-- models created in between. Records each model's current owner as a 'baseline' row. Ownership
-- before this point is not recorded anywhere, so earlier transfers cannot be reconstructed.
--
-- Batched by model id so no statement holds locks for long; re-run until it inserts 0 rows. A model
-- that already has a row is skipped.
--
-- Models owned by the placeholder account (-1) also need their creator, which only the analytics
-- store has: run scripts/oneoffs/model-ownership-creators.ts and apply the INSERTs it prints.

INSERT INTO "ModelOwnership" ("modelId", "userId", "reason")
SELECT m.id, m."userId", 'baseline'
FROM "Model" m
WHERE m.id IN (
  SELECT m2.id
  FROM "Model" m2
  WHERE NOT EXISTS (SELECT 1 FROM "ModelOwnership" o WHERE o."modelId" = m2.id)
  ORDER BY m2.id
  LIMIT 50000
);
