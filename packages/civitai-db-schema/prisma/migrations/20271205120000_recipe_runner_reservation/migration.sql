-- The Redis reservation legs a recipe-runner attempt holds (key names and amounts, never a token),
-- written by the reserved -> submitting move, so the sweeper and reconciler settle from the row.
-- Nullable, no backfill: attempts before this column carry none.
BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE runner_run_attempts ADD COLUMN IF NOT EXISTS reservation JSONB;
COMMIT;
