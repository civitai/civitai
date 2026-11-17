-- App Blocks: a viewer's per-app opt-in to run above-budget confirmed-step jobs without a
-- per-job confirm. The value is the highest job price, in Buzz, that may run unasked (the
-- price of the job the viewer opted in on); each job must also fit what is left of their own
-- daily limit for the app. NULL = not opted in.
--
-- Apply by hand; this repo does not run prisma migrate deploy. Apply BEFORE the code that
-- reads it ships (the order the Moderation Lead ruled), though either order is safe:
--   * Migration first: old code never names the column.
--   * Code first: `readConfirmWithinLimit` reads a missing column as not opted in and logs
--     once, so nobody skips a confirm; the clear-writes skip the column. No other grant read
--     or write names it.
--
-- Nullable with no default: metadata-only, no table rewrite, safe while the site is up. No
-- backfill: nobody has opted in, and a ceiling is never guessed.

ALTER TABLE "app_user_scope_grants"
  ADD COLUMN IF NOT EXISTS "confirm_within_limit_max_job" INTEGER;
