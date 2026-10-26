-- Post intent app mode: per-app approval record and one row per opened manifest URL.
-- NOT AUTO-APPLIED: a human runs this against each environment (dev first, then production).
-- Additive only (two new tables), idempotent, and free to apply before or after the deploy:
-- with the tables missing, app mode is refused and open mode is unaffected.
-- The per-app approval rows are data, not schema, and are inserted separately by a reviewer.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "app_post_intents" (
  "listing_id"     TEXT        NOT NULL PRIMARY KEY REFERENCES "app_listings"("id") ON DELETE CASCADE,
  "host"           TEXT        NOT NULL,
  "path_prefix"    TEXT        NOT NULL,
  "enabled"        BOOLEAN     NOT NULL DEFAULT true,
  "reviewed_by_id" INTEGER     REFERENCES "User"("id") ON DELETE SET NULL,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "app_post_intents_prefix_shape" CHECK ("path_prefix" LIKE '/%/' AND "host" = lower("host"))
);

CREATE TABLE IF NOT EXISTS "post_intent_manifests" (
  "id"               SERIAL      PRIMARY KEY,
  "manifest_url"     TEXT        NOT NULL,
  "app_id"           TEXT        NOT NULL,
  "listing_id"       TEXT        NOT NULL,
  "user_id"          INTEGER     NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "manifest"         JSONB       NOT NULL,
  "staged"           JSONB       NOT NULL DEFAULT '[]',
  "claim_expires_at" TIMESTAMPTZ NOT NULL,
  "post_id"          INTEGER     REFERENCES "Post"("id") ON DELETE SET NULL,
  "posted_at"        TIMESTAMPTZ,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "post_intent_manifests_manifest_url_key"
  ON "post_intent_manifests" ("manifest_url");
CREATE INDEX IF NOT EXISTS "post_intent_manifests_claim_expires_at_idx"
  ON "post_intent_manifests" ("claim_expires_at");
CREATE INDEX IF NOT EXISTS "post_intent_manifests_user_id_idx"
  ON "post_intent_manifests" ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "app_post_intents_host_path_prefix_key"
  ON "app_post_intents" ("host", "path_prefix");
