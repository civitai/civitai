-- Idempotent: applied by hand, possibly more than once.
--
-- A structured reason on mute and appeal rulings, from the fixed list in
-- `@civitai/shared/resolution-reasons`. TEXT rather than an enum so the list can change without a
-- migration; the app validates the value. `UserRestriction.internalNotes` is the moderator-only note
-- (`resolvedMessage` is shown to the user). Appeals already have `internalNotes`.
--
-- Nullable with no default, so each ADD COLUMN is a catalog change only, no table rewrite.
--
-- 🔴 APPLY BEFORE THE CODE THAT READS THESE COLUMNS DEPLOYS: Prisma's default select includes every
-- model field, so a missing column fails every UserRestriction and Appeal read.

SET lock_timeout = '5s';

ALTER TABLE "UserRestriction" ADD COLUMN IF NOT EXISTS "resolvedReason" TEXT;
ALTER TABLE "UserRestriction" ADD COLUMN IF NOT EXISTS "internalNotes" TEXT;
ALTER TABLE "Appeal" ADD COLUMN IF NOT EXISTS "resolvedReason" TEXT;
