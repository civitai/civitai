-- Kill the per-model install primitive. Absorb model_block_installs into
-- block_user_subscriptions by adding target_model_ids[] + slot_id + pinned
-- _version + block_instance_id columns. One install primitive instead of
-- two.
--
-- WHY: model_block_installs (per-model-pinned) and block_user_subscriptions
-- (blanket-on-all-my-models / on-all-pages-i-view) were two surfaces for
-- the same user intent — "install an app." Real users don't care about
-- the distinction. The data model carried both because the hackathon
-- shipped per-model first and subscriptions came later. block_user_
-- subscriptions already has target_model_types[] + target_base_models[]
-- filtering; adding target_model_ids[] lets it express "this app on THIS
-- one model" — covering 100% of what model_block_installs did.
--
-- SHAPE AFTER MIGRATION:
--   - publisher subscription, blanket:    target_model_ids=[],  slot_id=NULL
--   - publisher subscription, pinned:     target_model_ids=[X], slot_id='slot'
--   - viewer subscription (always blanket): target_model_ids=[], slot_id=NULL
--
-- block_instance_id stays NULL for blanket subscriptions (the SQL synthesises
-- bus_pub_<id> / bus_view_<id> on read). For the migrated row(s) the column
-- is populated with the OLD `bki_*` id so that block_buzz_attribution rows,
-- block_user_settings rows, and any in-flight tokens continue to resolve
-- through BlockRegistry.resolveBlockInstance.

BEGIN;

-- 1. Extend block_user_subscriptions with the four new columns.
ALTER TABLE "block_user_subscriptions"
  ADD COLUMN "target_model_ids" INTEGER[] NOT NULL DEFAULT '{}',
  ADD COLUMN "slot_id" TEXT,
  ADD COLUMN "pinned_version" TEXT,
  ADD COLUMN "block_instance_id" TEXT,
  ADD COLUMN "installed_by_user_id" INTEGER;

-- Length guards mirror model_block_installs constraints.
ALTER TABLE "block_user_subscriptions"
  ADD CONSTRAINT "block_user_subscriptions_instance_length_check"
  CHECK ("block_instance_id" IS NULL OR (char_length("block_instance_id") >= 28 AND char_length("block_instance_id") <= 64));

-- Unique on block_instance_id — preserves the existing
-- ModelBlockInstall.blockInstanceId @@unique invariant so look-ups by
-- bki_* id still uniquely resolve. Plain UNIQUE INDEX (not partial)
-- because Postgres treats NULL values as distinct in unique indexes by
-- default — multiple NULL rows coexist fine. The non-partial form is
-- also required for this column to be a valid FK target (partial
-- unique indexes can't be referenced by FKs).
CREATE UNIQUE INDEX "block_user_subscriptions_block_instance_id_unique"
  ON "block_user_subscriptions"("block_instance_id");

-- 2. Drop the old UNIQUE (user_id, app_block_id, scope) — a publisher can
-- now have one blanket sub + N pinned subs for the same app + scope, so
-- the constraint moves to a more permissive shape below.
ALTER TABLE "block_user_subscriptions"
  DROP CONSTRAINT "block_user_subscriptions_user_block_scope_uniq";

-- New uniqueness: at most ONE blanket subscription per (user, app, scope).
-- A blanket sub is one with empty target_model_ids AND NULL slot_id.
CREATE UNIQUE INDEX "block_user_subscriptions_blanket_uniq"
  ON "block_user_subscriptions"("user_id", "app_block_id", "scope")
  WHERE "slot_id" IS NULL AND cardinality("target_model_ids") = 0;

-- New uniqueness for pinned subs: at most ONE pinned subscription per
-- (user, app, scope, slot_id, target_model_id). The pinned shape always
-- has exactly one element in target_model_ids — enforced by the COALESCE
-- + array_length check rather than as a CHECK constraint, so we don't
-- box ourselves in if a future migration extends to multi-model pins.
CREATE UNIQUE INDEX "block_user_subscriptions_pinned_uniq"
  ON "block_user_subscriptions"("user_id", "app_block_id", "scope", "slot_id", ("target_model_ids"[1]))
  WHERE "slot_id" IS NOT NULL AND cardinality("target_model_ids") = 1;

-- Lookup index for listForModel — filtering pinned subs by single model id.
CREATE INDEX "block_user_subscriptions_pinned_model_idx"
  ON "block_user_subscriptions"("scope", "slot_id", ("target_model_ids"[1]))
  WHERE "slot_id" IS NOT NULL AND cardinality("target_model_ids") = 1;

-- 3. Migrate every model_block_installs row into a block_user_subscriptions
-- row. Scope=publisher_all_my_models; slot_id + target_model_ids populated;
-- block_instance_id preserved (so existing bki_* ids continue to resolve).
--
-- The (user, app, scope, slot, target_model_id) tuple is guaranteed unique
-- in source (model_block_installs UNIQUE on (model_id, app_block_id, slot_id),
-- and we map installed_by_user_id → user_id) so ON CONFLICT is defensive.
INSERT INTO "block_user_subscriptions" (
  "id",
  "user_id",
  "app_block_id",
  "scope",
  "target_model_types",
  "target_base_models",
  "target_model_ids",
  "slot_id",
  "settings",
  "enabled",
  "pinned_version",
  "block_instance_id",
  "installed_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  -- Generate a fresh bus_* id for the row PK. The old mbi_* id has no
  -- forward references (only block_buzz_attribution + block_scope_invocations
  -- use block_instance_id, which we preserve below).
  'bus_pin_' || substring(mbi.id from 5) AS id,
  mbi.installed_by_user_id AS user_id,
  mbi.app_block_id,
  'publisher_all_my_models' AS scope,
  '{}'::TEXT[] AS target_model_types,
  '{}'::TEXT[] AS target_base_models,
  ARRAY[mbi.model_id] AS target_model_ids,
  mbi.slot_id,
  mbi.settings,
  mbi.enabled,
  mbi.pinned_version,
  mbi.block_instance_id,  -- preserve the bki_* id for downstream resolution
  mbi.installed_by_user_id,
  mbi.installed_at,
  mbi.updated_at
FROM "model_block_installs" mbi
WHERE mbi.installed_by_user_id IS NOT NULL  -- safety: subscriptions require user_id NOT NULL
ON CONFLICT DO NOTHING;

-- 4. Repoint block_user_settings.block_instance_id FK from model_block
-- _installs to block_user_subscriptions. This is the per-viewer override
-- (currently 1 row: a checkpoint override for the migrated install).
ALTER TABLE "block_user_settings"
  DROP CONSTRAINT "block_user_settings_block_instance_id_fkey";

ALTER TABLE "block_user_settings"
  ADD CONSTRAINT "block_user_settings_block_instance_id_fkey"
  FOREIGN KEY ("block_instance_id")
  REFERENCES "block_user_subscriptions"("block_instance_id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

-- 5. Drop the model_block_installs table entirely. CASCADE clears any
-- remaining dependent objects (we've already manually repointed
-- block_user_settings). block_buzz_attribution + block_scope_invocations
-- carry block_instance_id as TEXT NOT NULL with no FK, so they're
-- unaffected — they resolve through BlockRegistry.resolveBlockInstance.
DROP TABLE "model_block_installs" CASCADE;

COMMIT;
