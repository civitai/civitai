-- Recipe runner: the offline spend cap on a consent, the runner client binding, run
-- authorizations, the per-run attempt ledger and its re-credit once-keys. Every object here is
-- `@no-type` (raw SQL only), so Prisma never selects it and the code may deploy before or after
-- this runs. Until it runs, the runner mint fails closed.
--
-- NOT AUTO-APPLIED: a human runs this file by hand (see CLAUDE.md -> Database), dev first, then
-- production. Idempotent: every statement is IF NOT EXISTS or guarded.
--
-- Two transactions:
-- 1. The "OauthConsent" columns: catalog-only (nullable, no default, no rewrite), behind a short
--    lock_timeout so a waiting ALTER does not queue the table's readers. On a timeout nothing is
--    applied; re-run it.
-- 2. The new tables. No lock on an existing table beyond the foreign-key checks.

BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE "OauthConsent" ADD COLUMN IF NOT EXISTS "offlineBuzzLimit" INTEGER;
ALTER TABLE "OauthConsent" ADD COLUMN IF NOT EXISTS "offlineBuzzPeriod" TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OauthConsent_offlineBuzzCap_check') THEN
    -- NOT VALID: existing rows all hold NULLs, so there is nothing to scan; new writes are checked.
    ALTER TABLE "OauthConsent" ADD CONSTRAINT "OauthConsent_offlineBuzzCap_check" CHECK (
      ("offlineBuzzLimit" IS NULL AND "offlineBuzzPeriod" IS NULL)
      OR ("offlineBuzzLimit" IS NOT NULL AND "offlineBuzzLimit" > 0 AND "offlineBuzzPeriod" IS NOT NULL
        AND "offlineBuzzPeriod" IN ('day', 'week', 'month'))
    ) NOT VALID;
  END IF;
END $$;
COMMIT;

BEGIN;

-- One runner client per recipe app, written only by Civitai admins. A suspended binding mints
-- nothing.
CREATE TABLE IF NOT EXISTS runner_client_bindings (
  runner_client_id   TEXT        PRIMARY KEY REFERENCES "OauthClient"(id) ON DELETE CASCADE,
  app_block_id       TEXT        NOT NULL UNIQUE REFERENCES app_blocks(id) ON DELETE CASCADE,
  status             TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_by_user_id INTEGER     NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  suspended_at       TIMESTAMPTZ,
  suspended_reason   TEXT,
  CHECK ((status = 'suspended') = (suspended_at IS NOT NULL))
);

-- What a user, in a live session, authorized a runner to start. `single` is one run;
-- `standing` is a recurring authorization capped per run and per period.
CREATE TABLE IF NOT EXISTS runner_run_authorizations (
  id                  TEXT        PRIMARY KEY,
  user_id             INTEGER     NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  runner_client_id    TEXT        NOT NULL REFERENCES "OauthClient"(id) ON DELETE CASCADE,
  kind                TEXT        NOT NULL CHECK (kind IN ('single', 'standing')),
  run_id              TEXT,
  recipe_version_hash TEXT        NOT NULL,
  params_hash         TEXT        NOT NULL,
  max_amount_per_run  INTEGER     NOT NULL CHECK (max_amount_per_run > 0),
  max_runs_per_period INTEGER     CHECK (max_runs_per_period > 0),
  period              TEXT        CHECK (period IN ('day', 'week', 'month')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ,
  revoked_reason      TEXT,
  CHECK (
    (kind = 'single' AND run_id IS NOT NULL AND max_runs_per_period IS NULL AND period IS NULL
      AND expires_at <= created_at + interval '24 hours')
    OR (kind = 'standing' AND run_id IS NULL AND max_runs_per_period IS NOT NULL
      AND period IS NOT NULL AND expires_at <= created_at + interval '30 days')
  ),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS runner_run_authorizations_user_client_idx
  ON runner_run_authorizations (user_id, runner_client_id) WHERE revoked_at IS NULL;

-- One row per submit attempt of a run. Postgres is authoritative for the runner's spend: the
-- offline cap is the sum of these rows over the cap's rolling period.
CREATE TABLE IF NOT EXISTS runner_run_attempts (
  attempt_id       TEXT        PRIMARY KEY,
  run_id           TEXT        NOT NULL,
  attempt_no       INTEGER     NOT NULL CHECK (attempt_no > 0),
  user_id          INTEGER     NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  runner_client_id TEXT        NOT NULL,
  app_block_id     TEXT        NOT NULL,
  authorization_id TEXT        NOT NULL REFERENCES runner_run_authorizations(id),
  state            TEXT        NOT NULL CHECK (state IN
                     ('reserved', 'submitting', 'unknown', 'submitted', 'settled', 'refunded', 'failed')),
  reserved_amount  INTEGER     NOT NULL CHECK (reserved_amount > 0),
  charged_amount   INTEGER     CHECK (charged_amount >= 0),
  workflow_id      TEXT,
  external_id      TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at       TIMESTAMPTZ,
  UNIQUE (run_id, attempt_no)
);
-- One live attempt per run: a new attempt only after every earlier one is refunded or failed.
CREATE UNIQUE INDEX IF NOT EXISTS runner_run_attempts_one_live_per_run
  ON runner_run_attempts (run_id)
  WHERE state IN ('reserved', 'submitting', 'unknown', 'submitted', 'settled');
CREATE INDEX IF NOT EXISTS runner_run_attempts_user_client_created_idx
  ON runner_run_attempts (user_id, runner_client_id, created_at);
-- The sweeper and reconciler read attempts by state.
CREATE INDEX IF NOT EXISTS runner_run_attempts_open_state_idx
  ON runner_run_attempts (state, updated_at)
  WHERE state IN ('reserved', 'submitting', 'unknown', 'submitted');

-- A refund transaction re-credits an attempt at most once.
CREATE TABLE IF NOT EXISTS runner_recredits (
  transaction_id TEXT        PRIMARY KEY,
  attempt_id     TEXT        NOT NULL REFERENCES runner_run_attempts(attempt_id),
  amount         INTEGER     NOT NULL CHECK (amount > 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
