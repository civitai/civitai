-- ============================================================
-- App Assistant session tracing — per-submission trace (app_publish_request_traces)
-- ============================================================
-- One row per publish request, written once at submit while the
-- `app-assistant-tracing` Flipt flag is on: the App Assistant chats that built
-- the app (the submitter's own app_assistant_session_links rows for the slug),
-- where each chat's transcript snapshot was frozen in the bundle store, and the
-- signals computed from the submitted bundle and those transcripts.
--
-- Read by moderators only (the review page and the moderator trace API).
--
-- Applied MANUALLY per environment; nothing auto-applies it. The application
-- tolerates the table being absent: the write is best-effort and a submission
-- never fails on it. Until it is applied, no traces are kept.
--
-- Idempotent: safe to run more than once. Cascades with its publish request.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "app_publish_request_traces" (
  "id"                 SERIAL         PRIMARY KEY,
  "publish_request_id" TEXT           NOT NULL,
  "slug"               TEXT           NOT NULL,
  "user_id"            INTEGER        NOT NULL,
  "conversation_ids"   TEXT[]         NOT NULL DEFAULT '{}',
  "snapshots"          JSONB          NOT NULL DEFAULT '[]',
  "signals"            JSONB          NOT NULL DEFAULT '{}',
  "signals_version"    INTEGER        NOT NULL,
  "snapshot_error"     TEXT,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "app_publish_request_traces_publish_request_id_fkey"
    FOREIGN KEY ("publish_request_id") REFERENCES "app_block_publish_requests"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "app_publish_request_traces_publish_request_id_key"
  ON "app_publish_request_traces" ("publish_request_id");

-- Every trace of an app, newest first.
CREATE INDEX IF NOT EXISTS "app_publish_request_traces_slug_idx"
  ON "app_publish_request_traces" ("slug", "created_at" DESC);

-- The aggregate signals read, by time window.
CREATE INDEX IF NOT EXISTS "app_publish_request_traces_created_idx"
  ON "app_publish_request_traces" ("created_at");

COMMIT;
