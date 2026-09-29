-- Moderator-set bitwise flags on a cosmetic (see CosmeticFlag in
-- src/shared/constants/cosmetic-flags.constants.ts). A column rather than a key
-- in "data" because creators own "data": replacing a sticker's artwork rebuilds
-- that blob wholesale and would silently drop a moderator's flag.
--
-- Apply BEFORE deploying the code that selects it. NOT NULL with a constant
-- default is a metadata-only change on Postgres 11+, so no table rewrite.
--
-- Applied manually per environment; re-runnable.
ALTER TABLE "Cosmetic" ADD COLUMN IF NOT EXISTS "flags" INTEGER NOT NULL DEFAULT 0;
