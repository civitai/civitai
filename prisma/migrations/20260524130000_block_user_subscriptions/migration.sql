-- ============================================================
-- App Blocks — user subscriptions (publisher + viewer scopes)
-- ============================================================
-- Two user-controlled install paths layered on top of the existing
-- model_block_installs (per-model, publisher) and platform_default_blocks
-- (mod-promoted) sources. See claudedocs/app-blocks-user-subscriptions-handoff.
--
-- Precedence in listForModel (highest to lowest):
--   1. model_block_installs row with enabled=true
--   2. model_block_installs row with enabled=false (publisher opt-out suppresses below)
--   3. block_user_subscriptions scope='publisher_all_my_models' where Model.userId matches
--   4. platform_default_blocks (mod-promoted)
--   5. block_user_subscriptions scope='viewer_personal' where viewer userId matches

CREATE TABLE "block_user_subscriptions" (
  -- Application-generated ULID: 'bus_<ulid>' (28-40 chars).
  "id"                    TEXT PRIMARY KEY,
  "user_id"               INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  -- RESTRICT for the same reason model_block_installs uses RESTRICT — an
  -- AppBlock under deprecation/tombstone shouldn't be hard-deleted while
  -- subscriptions exist.
  "app_block_id"          TEXT NOT NULL REFERENCES "app_blocks"("id") ON DELETE CASCADE,
  "scope"                 TEXT NOT NULL,
  -- NULL or empty array = applies to every model type / base model.
  "target_model_types"    TEXT[],
  "target_base_models"    TEXT[],
  -- Same shape as model_block_installs.settings. Carries publisher settings
  -- (buzz_budget_per_gen, default_checkpoint_version_id) for the
  -- subscription. Validated via blockSettingsSchemaByBlockId at write time.
  "settings"              JSONB NOT NULL DEFAULT '{}',
  "enabled"               BOOLEAN NOT NULL DEFAULT true,
  "created_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "block_user_subscriptions_user_block_scope_uniq"
    UNIQUE ("user_id", "app_block_id", "scope"),
  CONSTRAINT "block_user_subscriptions_scope_check"
    CHECK ("scope" IN ('publisher_all_my_models', 'viewer_personal')),
  -- Bound the TEXT primary key length. PK is `bus_` + 26 Crockford base32
  -- chars = 30 total. Allow a small window for any future prefix change.
  CONSTRAINT "block_user_subscriptions_id_length_check"
    CHECK (char_length("id") BETWEEN 28 AND 40)
);

-- Hot path: listForModel's publisher_all_my_models branch joins on
-- (user_id, scope='publisher_all_my_models', enabled=true). Partial index
-- keeps the lookup cheap and tiny — the vast majority of bus rows will not
-- match this predicate in steady state.
CREATE INDEX "bus_publisher_lookup_idx"
  ON "block_user_subscriptions" ("user_id", "app_block_id")
  WHERE "scope" = 'publisher_all_my_models' AND "enabled" = true;

-- Hot path: listForModel's viewer_personal branch joins on
-- (user_id, scope='viewer_personal', enabled=true).
CREATE INDEX "bus_viewer_lookup_idx"
  ON "block_user_subscriptions" ("user_id", "app_block_id")
  WHERE "scope" = 'viewer_personal' AND "enabled" = true;

-- For the management UI: "list all my subscriptions" ordered by updated_at
-- so the most recently changed rows surface first.
CREATE INDEX "bus_user_subscriptions_idx"
  ON "block_user_subscriptions" ("user_id", "updated_at" DESC);
