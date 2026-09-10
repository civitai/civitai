-- App Blocks consent budget — the per-UTC-day Buzz ceiling a VIEWER sets for ONE app
-- when they consent to `ai:write:budgeted`.
--
-- 🔴 APPLY THIS BEFORE THE IMAGE THAT READS IT ROLLS. Migrations in this project are
-- applied BY HAND, per environment; nothing in CI or the deploy runs them. The column is
-- additive and NULLable, so applying it EARLY is a no-op for the running code — but a
-- deploy that lands first makes every Prisma read of `AppUserScopeGrant` fail with a
-- missing-column error, which is a 500 on the consent + permissions surfaces.
--
-- WHY NULLABLE WITH NO BACKFILL. NULL means "the user set no budget", which is exactly
-- the state of every grant written before this column existed, and the spend path treats
-- it as "the platform's own 50,000/day per-user ceiling is the only one that applies".
-- Backfilling a number would silently TIGHTEN every existing consent to something the
-- user never agreed to. So: no backfill, no default.
--
-- `ADD COLUMN ... NULL` with no default is metadata-only in Postgres 11+ (no table
-- rewrite, no full-table lock beyond the brief ACCESS EXCLUSIVE for the catalog update),
-- so this is safe to apply while the site is up.
ALTER TABLE "app_user_scope_grants"
  ADD COLUMN IF NOT EXISTS "buzz_budget_per_day" INTEGER NULL;

-- Positive-if-present. The upper bound mirrors BLOCK_BUZZ_CAP_PER_DAY (50,000), the
-- platform per-user daily ceiling: a consent budget ABOVE it could never bind (the
-- platform cap would always be the tighter of the two), so accepting one would store a
-- number that means nothing. The same bound is enforced by the zod input on
-- `blocks.grantScopes`; this is the belt behind it, for any writer that is not that
-- procedure.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_user_scope_grants_buzz_budget_bounds'
  ) THEN
    ALTER TABLE "app_user_scope_grants"
      ADD CONSTRAINT "app_user_scope_grants_buzz_budget_bounds"
      CHECK (
        "buzz_budget_per_day" IS NULL
        OR ("buzz_budget_per_day" >= 1 AND "buzz_budget_per_day" <= 50000)
      );
  END IF;
END $$;
