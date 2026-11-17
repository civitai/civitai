-- App Blocks: a viewer's per-app opt-in to run above-budget confirmed-step jobs without a
-- per-job confirm. The value is the highest job price, in Buzz, that may run unasked (the
-- price of the job the viewer opted in on); each job must also fit what is left of their own
-- daily limit for the app. NULL = not opted in.
--
-- Apply by hand; this repo does not run prisma migrate deploy. Apply BEFORE the code that
-- reads it ships (old code never names the column). Code that lands first still never skips
-- a confirm: `readConfirmWithinLimit` reads a missing column as not opted in and the
-- clear-writes skip it. But the personal-data export builds its select from the Prisma schema,
-- so until this is applied that export reports this table as unavailable.
--
-- Nullable with no default: metadata-only, no table rewrite, safe while the site is up. No
-- backfill: nobody has opted in, and a ceiling is never guessed.

ALTER TABLE "app_user_scope_grants"
  ADD COLUMN IF NOT EXISTS "confirm_within_limit_max_job" INTEGER;
