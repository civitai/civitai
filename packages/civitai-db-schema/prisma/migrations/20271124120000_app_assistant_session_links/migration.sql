-- ============================================================
-- App Assistant session tracing — chat <-> app links (app_assistant_session_links)
-- ============================================================
-- One row per (conversation, app slug): which App Assistant chat worked on which
-- app, for which user, when it was first and last seen, how many finished turns
-- it reported, the last model, and the Buzz those turns were charged.
--
-- Written by POST /api/internal/app-assistant/turn (the server runner reports
-- every finished turn) while the `app-assistant-tracing` Flipt flag is on. Read
-- by moderators only, to resolve the chats that built a submitted app.
--
-- Applied MANUALLY per environment; nothing auto-applies it. The application
-- tolerates the table being absent: every write is best-effort (logged and
-- dropped), so a turn never fails on it. Until it is applied, no links are kept.
--
-- Idempotent: safe to run more than once.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "app_assistant_session_links" (
  "id"              SERIAL           PRIMARY KEY,
  "user_id"         INTEGER          NOT NULL,
  "conversation_id" TEXT             NOT NULL,
  "app_slug"        TEXT             NOT NULL,
  "first_seen_at"   TIMESTAMPTZ(6)   NOT NULL DEFAULT now(),
  "last_seen_at"    TIMESTAMPTZ(6)   NOT NULL DEFAULT now(),
  "turn_count"      INTEGER          NOT NULL DEFAULT 0,
  "last_model"      TEXT,
  "buzz_total"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  "last_run_id"     TEXT,
  "last_seq"        INTEGER,
  CONSTRAINT "app_assistant_session_links_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- The upsert key: one row per chat per app, per user (a conversation id is chosen by the
-- page, so it is only unique among one user's own chats).
CREATE UNIQUE INDEX IF NOT EXISTS "app_assistant_session_links_user_conversation_app_key"
  ON "app_assistant_session_links" ("user_id", "conversation_id", "app_slug");

-- A submission's chats: by app and submitter, newest first.
CREATE INDEX IF NOT EXISTS "app_assistant_session_links_app_user_idx"
  ON "app_assistant_session_links" ("app_slug", "user_id", "last_seen_at" DESC);

COMMIT;
