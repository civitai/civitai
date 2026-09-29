-- Moderator-set bitwise flags on a cosmetic (see CosmeticFlag in
-- src/shared/constants/cosmetic-flags.constants.ts). A column rather than a key
-- in "data" because creators own "data": replacing a sticker's artwork rebuilds
-- that blob wholesale and would silently drop a moderator's flag.
--
-- Apply BEFORE deploying the code that selects it. The shared cosmetic cache
-- selects it, so deploying first breaks cosmetics sitewide, not only stickers.
--
-- NOT NULL with a constant default is metadata-only, so no table rewrite. The
-- ALTER still takes a brief ACCESS EXCLUSIVE lock, and every "Cosmetic" read
-- queues behind it while it waits; the timeout makes it give up instead. Re-run
-- if it times out.
--
-- Applied manually per environment; re-runnable.
SET lock_timeout = '3s';
ALTER TABLE "Cosmetic" ADD COLUMN IF NOT EXISTS "flags" INTEGER NOT NULL DEFAULT 0;
