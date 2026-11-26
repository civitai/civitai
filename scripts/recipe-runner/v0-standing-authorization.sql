-- Recipe runner V0: bind a runner client to its recipe app and create one standing run
-- authorization, by hand, until the user-facing create/revoke flow exists.
--
-- Run with psql, one transaction, every value passed as a variable (nothing here names a real
-- user or client):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v runner_client_id=... -v app_block_id=... -v user_id=... -v created_by_user_id=... \
--     -v authorization_id=... -v recipe_version_hash=... -v params_hash=... \
--     -v max_amount_per_run=... -v max_runs_per_period=... -v period=day|week|month \
--     -v expires_at=2026-12-24T00:00:00Z \
--     -v offline_buzz_limit=... -v offline_buzz_period=day|week|month \
--     -f scripts/recipe-runner/v0-standing-authorization.sql
--
-- Dry run first: the same command with -v dry_run=1 rolls everything back at the end.
-- Needs migration 20271204120000_recipe_runner_ledger applied. Refuses (and changes nothing) when:
--   - the client is not a runner client (Civitai-owned, confidential, consent screen on, no device flow,
--     access mode open);
--   - the client is already bound to another app block, or its binding is suspended;
--   - expires_at is more than 30 days out;
--   - the app block is not approved;
--   - the user has no offline grant for the client;
--   - max_amount_per_run x max_runs_per_period exceeds the offline cap, or the periods differ.
--   - the consent already holds a cap other than the one passed.
-- The cap columns are set only while they are still empty, so a cap already there is never replaced.

\set ON_ERROR_STOP 1
\if :{?dry_run}
\else
  \set dry_run 0
\endif

BEGIN;

SELECT set_config('runner.client_id', :'runner_client_id', true),
       set_config('runner.app_block_id', :'app_block_id', true),
       set_config('runner.user_id', :'user_id', true),
       set_config('runner.created_by', :'created_by_user_id', true),
       set_config('runner.authorization_id', :'authorization_id', true),
       set_config('runner.recipe_version_hash', :'recipe_version_hash', true),
       set_config('runner.params_hash', :'params_hash', true),
       set_config('runner.max_amount_per_run', :'max_amount_per_run', true),
       set_config('runner.max_runs_per_period', :'max_runs_per_period', true),
       set_config('runner.period', :'period', true),
       set_config('runner.expires_at', :'expires_at', true),
       set_config('runner.cap_limit', :'offline_buzz_limit', true),
       set_config('runner.cap_period', :'offline_buzz_period', true);

DO $$
DECLARE
  v_client text := current_setting('runner.client_id');
  v_block text := current_setting('runner.app_block_id');
  v_user int := current_setting('runner.user_id')::int;
  v_per_run int := current_setting('runner.max_amount_per_run')::int;
  v_runs int := current_setting('runner.max_runs_per_period')::int;
  v_period text := current_setting('runner.period');
  v_cap_limit int := current_setting('runner.cap_limit')::int;
  v_cap_period text := current_setting('runner.cap_period');
  v_limit int;
  v_limit_period text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "OauthClient"
    WHERE id = v_client AND "userId" = -1 AND "isConfidential" AND NOT "skipConsent"
      AND NOT ('device_code' = ANY(grants)) AND "accessMode" = 'open'
  ) THEN
    RAISE EXCEPTION 'client % is not a runner client', v_client;
  END IF;
  IF current_setting('runner.expires_at')::timestamptz > now() + interval '30 days' THEN
    RAISE EXCEPTION 'expires_at % is more than 30 days out', current_setting('runner.expires_at');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_blocks WHERE id = v_block AND status = 'approved') THEN
    RAISE EXCEPTION 'app block % is not approved', v_block;
  END IF;

  INSERT INTO runner_client_bindings (runner_client_id, app_block_id, created_by_user_id)
  VALUES (v_client, v_block, current_setting('runner.created_by')::int)
  ON CONFLICT (runner_client_id) DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM runner_client_bindings
    WHERE runner_client_id = v_client AND app_block_id = v_block AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'client % is bound elsewhere or suspended', v_client;
  END IF;

  -- Set the cap only while it is empty; a different cap already there is refused below, never replaced.
  UPDATE "OauthConsent"
  SET "offlineBuzzLimit" = v_cap_limit, "offlineBuzzPeriod" = v_cap_period
  WHERE "userId" = v_user AND "clientId" = v_client
    AND "offlineGrantedAt" IS NOT NULL AND "offlineBuzzLimit" IS NULL;

  SELECT "offlineBuzzLimit", "offlineBuzzPeriod" INTO v_limit, v_limit_period
  FROM "OauthConsent"
  WHERE "userId" = v_user AND "clientId" = v_client AND "offlineGrantedAt" IS NOT NULL
  FOR UPDATE;
  IF v_limit IS NULL THEN
    RAISE EXCEPTION 'user % has no offline grant (or cap) for client %', v_user, v_client;
  END IF;
  IF v_limit <> v_cap_limit OR v_limit_period <> v_cap_period THEN
    RAISE EXCEPTION 'offline cap is already % per %, not the % per % passed; clear it deliberately first',
      v_limit, v_limit_period, v_cap_limit, v_cap_period;
  END IF;
  IF v_period <> v_limit_period THEN
    RAISE EXCEPTION 'authorization period % differs from the offline cap period %', v_period, v_limit_period;
  END IF;
  IF v_per_run::bigint * v_runs > v_limit THEN
    RAISE EXCEPTION 'max_amount_per_run x max_runs_per_period (%) exceeds the offline cap (%)',
      v_per_run::bigint * v_runs, v_limit;
  END IF;

  INSERT INTO runner_run_authorizations (
    id, user_id, runner_client_id, kind, recipe_version_hash, params_hash,
    max_amount_per_run, max_runs_per_period, period, expires_at
  ) VALUES (
    current_setting('runner.authorization_id'), v_user, v_client, 'standing',
    current_setting('runner.recipe_version_hash'), current_setting('runner.params_hash'),
    v_per_run, v_runs, v_period, current_setting('runner.expires_at')::timestamptz
  );
END $$;

SELECT runner_client_id, app_block_id, status FROM runner_client_bindings
WHERE runner_client_id = :'runner_client_id';
SELECT id, kind, max_amount_per_run, max_runs_per_period, period, expires_at
FROM runner_run_authorizations WHERE id = :'authorization_id';

\if :dry_run
  ROLLBACK;
\else
  COMMIT;
\endif
