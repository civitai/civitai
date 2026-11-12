-- ============================================================
-- App review: holds on a publish request
-- ============================================================
-- NOT AUTO-APPLIED. A human runs this file against the main civitai database, dev first, then
-- production, BEFORE the release that reads it rolls out. The approve paths fail closed while
-- this table is absent (approve is refused with a message naming the missing table); the review
-- queue's hold badge fails open.
--
-- ADDITIVE ONLY. One new, empty table and its indexes; no existing table, column or row changes,
-- and no foreign keys, so no lock is taken on any existing table. Idempotent (`IF NOT EXISTS`).
--
-- GRANTS: if new tables are not automatically granted in this environment, grant the role the
-- app writes with (its primary client) SELECT, INSERT and UPDATE on the table and USAGE on its
-- sequence. Every read and write goes through that client.
--
-- Read-back after applying: SELECT to_regclass('public.app_publish_request_holds');  -- non-null

BEGIN;

CREATE TABLE IF NOT EXISTS "app_publish_request_holds" (
  "id"                 SERIAL PRIMARY KEY,
  "slug"               TEXT        NOT NULL,
  "publish_request_id" TEXT        NOT NULL,
  "request_kind"       TEXT        NOT NULL,
  "placed_by_user_id"  INTEGER     NOT NULL,
  "placed_by_label"    TEXT        NOT NULL,
  "reason"             TEXT        NOT NULL,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "cleared_at"         TIMESTAMPTZ,
  "cleared_by_user_id" INTEGER,
  "cleared_kind"       TEXT,
  "cleared_reason"     TEXT,
  CONSTRAINT "app_publish_request_holds_kind_chk" CHECK ("request_kind" IN ('onsite', 'listing')),
  CONSTRAINT "app_publish_request_holds_label_chk" CHECK (char_length("placed_by_label") BETWEEN 1 AND 80),
  CONSTRAINT "app_publish_request_holds_reason_chk" CHECK (char_length("reason") BETWEEN 10 AND 2000),
  CONSTRAINT "app_publish_request_holds_cleared_chk" CHECK (
    ("cleared_at" IS NULL AND "cleared_kind" IS NULL AND "cleared_reason" IS NULL AND "cleared_by_user_id" IS NULL)
    OR ("cleared_at" IS NOT NULL AND "cleared_kind" IN ('cleared', 'overridden')
        AND char_length("cleared_reason") BETWEEN 10 AND 2000 AND "cleared_by_user_id" IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS "app_publish_request_holds_open_slug_idx"
  ON "app_publish_request_holds" ("slug") WHERE "cleared_at" IS NULL;
CREATE INDEX IF NOT EXISTS "app_publish_request_holds_request_idx"
  ON "app_publish_request_holds" ("publish_request_id");
CREATE INDEX IF NOT EXISTS "app_publish_request_holds_slug_created_idx"
  ON "app_publish_request_holds" ("slug", "created_at" DESC);

COMMIT;
