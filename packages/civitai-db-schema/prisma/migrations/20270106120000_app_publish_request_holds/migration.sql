-- ============================================================
-- App review: holds on a publish request
-- ============================================================
-- NOT AUTO-APPLIED. A human runs this file against the main civitai database, dev first, then
-- production, BEFORE the release that reads it rolls out. The approve paths fail closed while
-- this table is absent (approve is refused with a message naming the missing table); the review
-- queue's hold badge fails open.
--
-- ADDITIVE ONLY. Two new, empty tables and their indexes; no existing table, column or row changes,
-- and no foreign keys, so no lock is taken on any existing table. Idempotent (`IF NOT EXISTS`).
--
-- GRANTS: if new tables are not automatically granted in this environment, grant the role the
-- app connects as SELECT, INSERT and UPDATE on app_publish_request_holds, USAGE on its id
-- sequence, and SELECT, INSERT, UPDATE and DELETE on app_publish_request_approve_claims. The
-- review queue also reads app_publish_request_holds through the read client's role (SELECT).
--
-- Read-back after applying, as an owner (replace <app_role> with the role the app connects as):
--   SELECT to_regclass('public.app_publish_request_holds'),
--          to_regclass('public.app_publish_request_approve_claims');               -- both non-null
--   SELECT has_table_privilege('<app_role>', 'app_publish_request_holds', 'SELECT,INSERT,UPDATE'),
--          has_sequence_privilege('<app_role>', 'app_publish_request_holds_id_seq', 'USAGE'),
--          has_table_privilege('<app_role>', 'app_publish_request_approve_claims',
--                              'SELECT,INSERT,UPDATE,DELETE');                     -- all true

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

-- One row per app while an on-site approve that has passed its hold check is running; placing a
-- hold is refused while a fresh row exists. Rows are deleted when the approve ends.
CREATE TABLE IF NOT EXISTS "app_publish_request_approve_claims" (
  "slug"               TEXT        PRIMARY KEY,
  "publish_request_id" TEXT        NOT NULL,
  "claimed_by_user_id" INTEGER     NOT NULL,
  "claimed_at"         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "app_publish_request_approve_claims_request_idx"
  ON "app_publish_request_approve_claims" ("publish_request_id");

COMMIT;
