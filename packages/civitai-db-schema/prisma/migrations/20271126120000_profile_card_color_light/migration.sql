-- Profile redesign: a members-only card colour and opacity for visitors in light mode.
-- Apply before the code that reads these columns deploys: a missing column breaks every profile
-- read, flag or not. Nullable with no default, so this only changes the catalog.
SET lock_timeout = '5s';

ALTER TABLE "UserProfile"
  ADD COLUMN IF NOT EXISTS "cardColorLight" TEXT,
  ADD COLUMN IF NOT EXISTS "cardOpacityLight" INTEGER;
