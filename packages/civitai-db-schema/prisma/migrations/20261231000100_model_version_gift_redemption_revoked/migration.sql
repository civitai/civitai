-- A creator can remove one claimer's gifted access (docs/features/model-gift-links.md).
--
-- Apply BEFORE deploying the code that reads these columns: the claim path selects them.
-- Hand-applied. Two nullable columns with no default: a catalog-only change, no table rewrite,
-- no backfill.
-- Dry run: the whole file inside BEGIN; ... ROLLBACK;.

ALTER TABLE "ModelVersionGiftRedemption"
  ADD COLUMN "revokedAt" TIMESTAMP(3),
  ADD COLUMN "revokedById" INTEGER;
