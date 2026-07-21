-- Model the "Outbox" table in the Prisma-managed schema, and add the poller's `attempts` column.
--
-- The OutboxEntity enum + Outbox table already exist in production (created/applied manually by the event
-- pipeline; the earlier `outbox_entity_add_values` work `ALTER TYPE`d this enum, so it pre-exists). This
-- migration documents them so fresh/dev databases get the full table, while being fully idempotent so
-- applying it to an existing database is a safe no-op except for adding any missing columns.
--
-- `attempts` backs the event-engine OutboxPoller's retry bookkeeping: it bumps the counter on each failed
-- handler attempt so a stuck/poison row is visible (queryable) and can be "parked" past a max-attempts cap,
-- then re-driven via `pnpm --filter @civitai/event-engine redrive:outbox`. Nullable; readers treat NULL as 0.
--
-- Sequencing note: apply this BEFORE enabling the poller (OUTBOX_POLL_ENABLED=true) — until the column
-- exists the poller's SELECT/UPDATE errors every sweep, which is why it ships DEFAULT OFF.

-- Enum (create if missing).
DO $$ BEGIN
  CREATE TYPE "OutboxEntity" AS ENUM ('Article', 'Image', 'Model', 'Post', 'ModelVersion');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Table (create if missing) — mirrors the production shape.
CREATE TABLE IF NOT EXISTS "Outbox" (
  "id"         BIGSERIAL PRIMARY KEY,
  "event"      TEXT NOT NULL,
  "entityType" "OutboxEntity" NOT NULL,
  "entityId"   BIGINT NOT NULL,
  "createdAt"  TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "details"    JSONB,
  "attempts"   INTEGER
);

-- For databases where the table pre-existed without these columns, add them idempotently.
ALTER TABLE "Outbox" ADD COLUMN IF NOT EXISTS "details" JSONB;
ALTER TABLE "Outbox" ADD COLUMN IF NOT EXISTS "attempts" INTEGER;
