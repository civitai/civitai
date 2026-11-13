-- App Blocks: App Storage schema migrations — one row per (publish request, collection) whose
-- declared migration ops run over that collection's stored documents.
--
-- NOT AUTO-APPLIED: a human runs this file by hand (see CLAUDE.md -> Database), dev first, then
-- production. Order relative to the code is free: until the table exists, approve refuses any
-- version that plans a migration, and every other approve proceeds as before.
--
-- Written and read by raw SQL only (`storage-migration-run.service.ts`); the Prisma model is
-- `@no-type`. Additive and idempotent; safe to re-run. Bounded by lock_timeout (the foreign keys
-- lock the two referenced tables); re-run the file on a timeout.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "app_storage_migration_runs" (
    "publish_request_id" TEXT NOT NULL,
    "collection" TEXT NOT NULL,
    "app_block_id" TEXT NOT NULL,
    -- The mutation ops to apply, as validated at submit (default / rename / remove).
    "ops" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    -- Where the run stopped: the last { scopeUid, key } it read. NULL before the first page.
    "cursor" JSONB,
    "scanned" INTEGER NOT NULL DEFAULT 0,
    "migrated" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    -- Documents that still do not match the collection's schema after the run.
    "invalid" INTEGER NOT NULL DEFAULT 0,
    -- A sample of the documents whose rewrite was refused: [{ scopeUid, key, code }].
    "failures" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "last_error" TEXT,
    -- Consecutive failed attempts (a deterministic page failure, or a runner lost mid-page);
    -- at 5 the run is 'failed' and no longer picked.
    "attempts" INTEGER NOT NULL DEFAULT 0,
    -- The claim the current runner holds; a save under any other token is refused.
    "claim_token" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "heartbeat_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "app_storage_migration_runs_pkey" PRIMARY KEY ("publish_request_id", "collection"),
    CONSTRAINT "app_storage_migration_runs_status_check"
      CHECK ("status" IN ('pending', 'running', 'completed', 'completed_with_failures', 'failed', 'superseded')),
    CONSTRAINT "app_storage_migration_runs_publish_request_fkey"
      FOREIGN KEY ("publish_request_id") REFERENCES "app_block_publish_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "app_storage_migration_runs_app_block_fkey"
      FOREIGN KEY ("app_block_id") REFERENCES "app_blocks"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Idempotent; safe to re-run (no-ops on the table created above).
ALTER TABLE "app_storage_migration_runs" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "app_storage_migration_runs" ADD COLUMN IF NOT EXISTS "claim_token" TEXT;

-- The resume job's read: the runs still to do, least recently touched first. Idempotent; safe to
-- re-run.
DROP INDEX IF EXISTS "app_storage_migration_runs_open_idx";
CREATE INDEX IF NOT EXISTS "app_storage_migration_runs_open_idx"
  ON "app_storage_migration_runs"("heartbeat_at" NULLS FIRST, "created_at")
  WHERE "status" IN ('pending', 'running');

-- The app_blocks FK's cascade, "this app's runs", and approve's "is a run of this app open".
CREATE INDEX IF NOT EXISTS "app_storage_migration_runs_app_block_idx"
  ON "app_storage_migration_runs"("app_block_id");
