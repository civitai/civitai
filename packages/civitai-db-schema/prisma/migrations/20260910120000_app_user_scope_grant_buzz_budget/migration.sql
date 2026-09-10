-- App Blocks consent budget — the per-UTC-day Buzz ceiling a VIEWER sets for ONE app
-- when they consent to `ai:write:budgeted`.
--
-- APPLY ORDER: either order is safe. Migrations in this project are applied BY HAND,
-- per environment; nothing in CI or the deploy runs them, so the image and the schema
-- are never deployed atomically and BOTH orders happen in practice.
--   * Migration first  → a no-op for the running code (the column is additive and
--                        NULLable; nothing reads it until the new image lands).
--   * Deploy first     → the app runs CORRECTLY without the column, and reports
--                        "no consent budget set" for every user, which is the TRUE
--                        state of a database that cannot store one. The platform's own
--                        per-user daily Buzz ceiling (BLOCK_BUZZ_CAP_PER_DAY = 50,000)
--                        keeps enforcing throughout. Every read of this column is
--                        wrapped: `getConsentBuzzBudget` and `listMyScopeGrants` catch
--                        Prisma P2022 SPECIFICALLY (never a bare catch — any other DB
--                        error still throws) and log it once, loudly, at error level;
--                        every WRITE of the grant row passes an explicit `select` so it
--                        never reads the column back.
--
-- ⚠️ THIS HEADER PREVIOUSLY WARNED THAT A DEPLOY-FIRST ORDER MAKES "every Prisma read
-- of AppUserScopeGrant fail … a 500 on the consent + permissions surfaces". That was
-- accurate when written and was MEASURED on this PR's preview environment
-- (`P2022 … app_user_scope_grants.buzz_budget_per_day does not exist` on
-- blocks.upsertSubscription → recordInstallConsent → appUserScopeGrant.update, surfacing
-- as INTERNAL_SERVER_ERROR). The blast radius was actually WIDER than that sentence
-- said — it 500'd every grant WRITE (install / subscribe / re-consent) as well as the
-- reads, because Prisma's default selection returns every scalar and so a `create` /
-- `update` with no `select` emits `RETURNING … buzz_budget_per_day` too. Both halves are
-- fixed in the code that ships WITH this migration; the warning is kept here as the
-- record of why the guards exist, not as a live hazard.
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
--
-- DELIBERATELY A PLAIN `ADD CONSTRAINT`, NOT `NOT VALID` + `VALIDATE CONSTRAINT`.
-- A plain ADD scans the whole table under ACCESS EXCLUSIVE to prove the existing rows
-- satisfy it. That is the right trade HERE and only because of what this table is: the
-- column was created NULL two statements earlier in this same migration, so EVERY row
-- trivially satisfies the check (`IS NULL`), and the scan is over a consent ledger with
-- one row per (user, approved app) on a pre-GA, moderator-gated feature — small, and
-- nothing in the transaction can grow it. The two-step form buys a shorter lock at the
-- cost of a constraint that is briefly unenforced against concurrent writers and a
-- second statement an operator applying this by hand can forget. If this table is ever
-- large when a future bounds change lands, use the two-step form then — the reason to
-- prefer the simple one is the emptiness of the predicate, not a rule about CHECKs.
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
