-- The monthly gift claim limit counts claims across all of a creator's links
-- (docs/features/model-gift-links.md), so the claim path looks links up by "createdById".
--
-- Hand-applied, outside a transaction (CONCURRENTLY). Apply before deploying the code that counts by
-- creator; without it that count scans the link table on every new claim.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ModelVersionGiftLink_createdById_idx" ON "ModelVersionGiftLink" ("createdById");
