-- Perceptual hash for cosmetic artwork, so near-duplicate submissions can be
-- detected where the existing sha256 (which a re-encode defeats) cannot.
--
-- `pHashUrl` records which `data.url` produced `pHash`. Several paths replace a
-- cosmetic's artwork with a raw UPDATE, so the two disagreeing is how the
-- backfill spots a hash that no longer describes the current image.
--
-- Applied manually per environment; re-runnable.
ALTER TABLE "Cosmetic" ADD COLUMN IF NOT EXISTS "pHash" BIGINT;
ALTER TABLE "Cosmetic" ADD COLUMN IF NOT EXISTS "pHashUrl" TEXT;
