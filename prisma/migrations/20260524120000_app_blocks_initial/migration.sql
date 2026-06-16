-- ============================================================
-- App Blocks Schema — v1 + v2 substrate columns included
-- ============================================================
-- See docs/features/app-blocks.md for the architecture overview.

-- The block registry: all registered blocks across all apps
-- FK references "OauthClient" (verified table name — no @@map directive on the Prisma model)
CREATE TABLE "app_blocks" (
  "id"                    TEXT PRIMARY KEY,
  "app_id"                TEXT NOT NULL,
  "block_id"              TEXT NOT NULL,
  "version"               TEXT NOT NULL,
  "manifest"              JSONB NOT NULL,
  "status"                TEXT NOT NULL DEFAULT 'pending',
  "content_rating"        TEXT NOT NULL,
  "promotion_eligible"    BOOLEAN NOT NULL DEFAULT false,
  "health_status"         TEXT NOT NULL DEFAULT 'unknown',
  "health_checked_at"     TIMESTAMPTZ,

  -- v2 substrate columns (NULL-safe for v1 installs, included now to avoid later migration)
  "render_mode"           TEXT NOT NULL DEFAULT 'iframe',
  "trust_tier"            TEXT NOT NULL DEFAULT 'unverified',
  "asset_bundle_url"      TEXT,
  "asset_bundle_sha256"   TEXT,

  -- H-2 (audit): scope set captured at moderator approval. Empty array =
  -- never been approved (semantic NULL); fail-closed in token issuance.
  -- The manifest's scopes can change post-approval (publishers re-publish;
  -- we already reset status='pending' on any change), but token issuance
  -- also needs to refuse scopes outside the approved set.
  "approved_scopes"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  "created_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "app_blocks_app_id_fk"
    FOREIGN KEY ("app_id") REFERENCES "OauthClient"("id") ON DELETE CASCADE,
  CONSTRAINT "app_blocks_app_block_uniq"
    UNIQUE ("app_id", "block_id"),
  CONSTRAINT "app_blocks_render_mode_check"
    CHECK ("render_mode" IN ('iframe', 'inline', 'hybrid')),
  CONSTRAINT "app_blocks_trust_tier_check"
    CHECK ("trust_tier" IN ('unverified', 'verified', 'internal')),
  CONSTRAINT "app_blocks_content_rating_check"
    CHECK ("content_rating" IN ('g', 'pg', 'pg13', 'r', 'x')),
  CONSTRAINT "app_blocks_status_check"
    CHECK ("status" IN ('pending', 'approved', 'suspended', 'deprecated')),
  CONSTRAINT "app_blocks_health_status_check"
    CHECK ("health_status" IN ('unknown', 'healthy', 'degraded', 'down'))
);

-- Per-model, per-block install record. An install row pins the block to a single
-- slot — a block that can render in multiple slots is installed once per slot.
-- This mirrors platform_default_blocks.slot_id and prevents one install from
-- leaking across slots in listForModel.
CREATE TABLE "model_block_installs" (
  "id"                    TEXT PRIMARY KEY,
  "model_id"              INTEGER NOT NULL REFERENCES "Model"("id") ON DELETE CASCADE,
  "model_version_id"      INTEGER REFERENCES "ModelVersion"("id") ON DELETE SET NULL,
  -- RESTRICT instead of CASCADE: an AppBlock should never be hard-deleted
  -- while installs exist. The lifecycle path is status='deprecated' →
  -- 'suspended' → tombstone. NO ACTION would silently block deletion at
  -- the DB level; RESTRICT is the explicit version of that.
  "app_block_id"          TEXT NOT NULL REFERENCES "app_blocks"("id") ON DELETE RESTRICT,
  "slot_id"               TEXT NOT NULL,
  "block_instance_id"     TEXT NOT NULL UNIQUE,
  "settings"              JSONB NOT NULL DEFAULT '{}',
  "enabled"               BOOLEAN NOT NULL DEFAULT true,
  "installed_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- SET NULL on installer deletion: a block published by a now-deleted user
  -- should NOT be torn down (the model owner still wants it). The audit log
  -- records who deleted; the installer slot becomes anonymous.
  "installed_by_user_id"  INTEGER REFERENCES "User"("id") ON DELETE SET NULL,
  "updated_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- (model, app_block, slot) is unique so toggleEnabled(false) on a single
  -- (slot, block) pair acts as opt-out for that slot only. Same block in a
  -- different slot is a separate install row.
  CONSTRAINT "model_block_installs_model_app_slot_uniq"
    UNIQUE ("model_id", "app_block_id", "slot_id")
);

CREATE INDEX "model_block_installs_model_slot_enabled_idx"
  ON "model_block_installs" ("model_id", "slot_id", "enabled");
CREATE INDEX "model_block_installs_app_block_idx"
  ON "model_block_installs" ("app_block_id");
-- Hot path: moderation looks up "all installs by this user" when reviewing
-- a reported publisher. Without this, that query is a seq-scan.
CREATE INDEX "model_block_installs_installed_by_idx"
  ON "model_block_installs" ("installed_by_user_id");
-- H-9 (audit): without this, ModelVersion delete (which SET-NULLs this FK)
-- triggers a seq-scan on every model_block_install row.
CREATE INDEX "model_block_installs_model_version_idx"
  ON "model_block_installs" ("model_version_id") WHERE "model_version_id" IS NOT NULL;

-- Per-block-instance, per-user settings (viewer preferences).
-- block_instance_id FK CASCADEs on install deletion (model delete cascades
-- installs → cascades viewer prefs). user_id CASCADE for GDPR delete.
CREATE TABLE "block_user_settings" (
  "block_instance_id"   TEXT NOT NULL REFERENCES "model_block_installs"("block_instance_id") ON DELETE CASCADE,
  "user_id"             INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "settings"            JSONB NOT NULL DEFAULT '{}',
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("block_instance_id", "user_id")
);
-- GDPR delete path scans by user_id; primary key starts on block_instance_id.
CREATE INDEX "block_user_settings_user_idx"
  ON "block_user_settings" ("user_id");

-- Platform-default blocks (promoted to render on all eligible model pages).
CREATE TABLE "platform_default_blocks" (
  -- RESTRICT: don't allow hard delete of an AppBlock that's currently
  -- promoted as a platform default. Demote first (DELETE from this table).
  "app_block_id"          TEXT PRIMARY KEY REFERENCES "app_blocks"("id") ON DELETE RESTRICT,
  "slot_id"               TEXT NOT NULL,
  "target_model_types"    TEXT[],
  "min_content_rating"    TEXT,
  "max_content_rating"    TEXT,
  "priority"              INTEGER NOT NULL DEFAULT 500,
  "enabled"               BOOLEAN NOT NULL DEFAULT true,
  "promoted_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- M2 (audit): SET NULL on user delete, not RESTRICT. RESTRICT would
  -- block GDPR/user-deletion pipelines forever — every mod who ever
  -- promoted a default would become un-deletable until the promotion was
  -- manually removed. The promoted_by column is informational; the audit
  -- log (Phase 3) preserves the original attribution.
  "promoted_by"           INTEGER REFERENCES "User"("id") ON DELETE SET NULL
);

CREATE INDEX "platform_default_blocks_slot_enabled_idx"
  ON "platform_default_blocks" ("slot_id", "enabled");
-- listForModel's UNION sorts platform defaults by priority within (slot_id,
-- enabled=true). Without this, that query plans a sort over a heap scan.
CREATE INDEX "platform_default_blocks_slot_priority_idx"
  ON "platform_default_blocks" ("slot_id", "priority") WHERE "enabled" = true;
-- H-9 (audit): User delete (ON DELETE RESTRICT on promoted_by) requires
-- scanning this column to confirm "no rows reference this user." Without
-- the index, every user-delete pays an O(N) sweep.
CREATE INDEX "platform_default_blocks_promoted_by_idx"
  ON "platform_default_blocks" ("promoted_by");

-- H-10 (audit): the previous `("id") WHERE status='approved'` partial
-- index was dead weight — JOINs against app_blocks resolve via the
-- primary key. listForModel's join condition becomes `ON ab.id = ...`
-- + a WHERE on `ab.status`. The replacement indexes status directly,
-- which actually accelerates the admin "list pending approvals" lookups.
CREATE INDEX "app_blocks_status_idx" ON "app_blocks" ("status");

-- M-8 (audit): constrain slot_id to the v1 enum at the DB layer. The
-- router already validates via z.enum, but a direct DB write or future
-- ingestion path could land garbage. Phase 2 widens this list.
ALTER TABLE "model_block_installs" ADD CONSTRAINT "model_block_installs_slot_id_check"
  CHECK ("slot_id" IN ('model.sidebar_top', 'model.below_images', 'model.actions_extra'));
ALTER TABLE "platform_default_blocks" ADD CONSTRAINT "platform_default_blocks_slot_id_check"
  CHECK ("slot_id" IN ('model.sidebar_top', 'model.below_images', 'model.actions_extra'));

-- M-9 (audit): bound the TEXT primary key lengths. Each PK is a prefixed
-- ULID (ab_/mbi_/bki_ + 26 Crockford base32 chars = 29-30 total). Allow a
-- small window (28-40) for a future prefix change but stop a buggy caller
-- from inserting 'a'.repeat(1_000_000).
ALTER TABLE "app_blocks" ADD CONSTRAINT "app_blocks_id_length_check"
  CHECK (char_length("id") BETWEEN 28 AND 40);
ALTER TABLE "model_block_installs" ADD CONSTRAINT "model_block_installs_id_length_check"
  CHECK (char_length("id") BETWEEN 28 AND 40);
ALTER TABLE "model_block_installs" ADD CONSTRAINT "model_block_installs_instance_length_check"
  CHECK (char_length("block_instance_id") BETWEEN 28 AND 40);
