-- ============================================================
-- IdempotencyKey: "has this already been done?" markers that must not be evicted
-- ============================================================
-- NOT AUTO-APPLIED. Migrations in this repo are applied by hand (see CLAUDE.md -> Database):
-- there is no `prisma migrate deploy` path. A human runs this file against the main civitai
-- database, dev first, then production.
--
-- APPLY IT BEFORE turning on the `idempotency-keys-pg` flag. The code does not need it before
-- then: with the flag off nothing reads or writes this table. The model is marked no-type in
-- `schema.full.prisma`, so the generated Prisma client never names it, and every read and write
-- is raw SQL in `src/server/services/idempotency-key.service.ts`. With the flag ON and the table
-- missing, each caller refuses rather than act twice (a moderator DM or a headless post answers
-- 503; the Stripe AIR webhook answers 400 so Stripe retries).
--
-- WHAT IT HOLDS. One row per (scope, key) that something has claimed. `state` is 'pending' while
-- the action runs and 'done' once its result is stored; `expiresAt` is when the row stops
-- counting (a lapsed pending row can be taken over by the next caller). Scopes today:
-- 'message-as-civitai', 'headless-post', 'stripe-air'. Expired rows are deleted by the
-- `idempotency-key-purge` job.
--
-- Additive and idempotent (`IF NOT EXISTS`). A new, empty table: no backfill, no foreign key,
-- no lock on any existing table.
--
-- ROLLBACK: turn the flag off; the code goes back to sysRedis, which the flag-on code keeps
-- writing too. Dropping the table is safe once the flag is off.

SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "IdempotencyKey" (
  "scope"     TEXT           NOT NULL,
  "key"       TEXT           NOT NULL,
  "state"     TEXT           NOT NULL,
  "result"    JSONB,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("scope", "key"),
  CONSTRAINT "IdempotencyKey_state_check" CHECK ("state" IN ('pending', 'done'))
);

CREATE INDEX IF NOT EXISTS "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey" ("expiresAt");

-- VERIFY THE SCHEMA. `IF NOT EXISTS` reports success either way. Must return exactly six rows:
-- scope text NO, key text NO, state text NO, result jsonb YES,
-- createdAt timestamp with time zone NO, expiresAt timestamp with time zone NO.
--
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'IdempotencyKey'
--   ORDER BY ordinal_position;
--
-- And two indexes, IdempotencyKey_pkey and IdempotencyKey_expiresAt_idx:
--
--   SELECT indexname FROM pg_indexes WHERE tablename = 'IdempotencyKey' ORDER BY indexname;
