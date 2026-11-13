-- A pack's first box draws from its guaranteed tiers only; the record says which draws did.
ALTER TABLE "BoxOpening" ADD COLUMN IF NOT EXISTS "guaranteed" BOOLEAN NOT NULL DEFAULT false;
