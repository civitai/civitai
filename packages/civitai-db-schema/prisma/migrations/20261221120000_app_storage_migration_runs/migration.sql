-- App Blocks: App Storage schema migrations — one row per (approved publish request, collection)
-- whose declared migration ops run over that collection's stored documents.
--
-- NOT AUTO-APPLIED: a human runs this file by hand (see CLAUDE.md -> Database), dev first, then
-- production. Order relative to the code is free: until the table exists, an approval that has a
-- migration plan still runs it once, in-process, and logs the outcome instead of recording it
-- (`storage-migration-run.service.ts`); nothing resumes an interrupted run until it lands.
--
-- Written and read by raw SQL only (`storage-migration-run.service.ts`); the Prisma model is
-- `@no-type`. Additive and idempotent. Bounded by lock_timeout (the foreign keys lock the two
-- referenced tables); re-run the file on a timeout.

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

-- The resume job's read: the runs still to do, oldest first.
CREATE INDEX IF NOT EXISTS "app_storage_migration_runs_open_idx"
  ON "app_storage_migration_runs"("created_at")
  WHERE "status" IN ('pending', 'running');

-- The app_blocks FK's cascade, and "this app's runs".
CREATE INDEX IF NOT EXISTS "app_storage_migration_runs_app_block_idx"
  ON "app_storage_migration_runs"("app_block_id");
