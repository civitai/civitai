-- ============================================================
-- App Blocks — agentic mod code-review report: SLUG-KEYING correction (P1)
-- ============================================================
-- Follow-up to 20260720120000_app_review_agent_report. That table keyed a report
-- to the app via app_block_id XOR oauth_client_id — but an on-site AppBlock row
-- does not exist until the FIRST version is APPROVED, so a first-version onsite
-- review had no key and could not be persisted. The stable identifier present on
-- EVERY publish request (first version included) is the app SLUG (= blockId), so
-- onsite reports are re-keyed by slug.
--
-- Changes (all additive / safe on the EXISTING, already-applied, EMPTY table):
--   1. slug           TEXT NOT NULL          — the stable app key (blockId).
--   2. kind           TEXT NOT NULL 'onsite' — 'onsite' | 'external' (CHECK).
--   3. drop the app_key XOR CHECK — app_block_id / oauth_client_id become
--      OPTIONAL informational columns (nullable, no exactly-one invariant).
--   4. swap the (app_block_id, version) + (oauth_client_id, version) covering
--      indexes for (slug, version) — the prior-report lookup now scopes by slug.
--   5. status CHECK gains 'cost-capped' (the runner's cost-cap outcome is now
--      persisted verbatim instead of being collapsed onto 'failed').
--   6. a PARTIAL UNIQUE index on (publish_request_id) WHERE status='running' —
--      makes a second concurrent `running` row for one request impossible at the
--      DB (the double-provision backstop).
--
-- ⚠️ MANUAL APPLY — per datapacket-talos CLAUDE.md DB rule #8 the main civitai
-- CNPG nvme0 DB does NOT auto-apply migrations (no prisma migrate deploy). This
-- file is committed for HISTORY ONLY; a HUMAN applies the SQL below per
-- environment (psql/retool). CI / deploy do NOT run it. Apply to BOTH:
--   1. prod nvme0   (the live civitai DB)
--   2. the dev clone
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS / DROP INDEX
-- IF EXISTS / CREATE [UNIQUE] INDEX IF NOT EXISTS + re-add-after-drop for CHECKs,
-- so a manual re-run is a no-op. The table is brand-new + EMPTY, so adding a
-- NOT NULL column with no default and building indexes take no meaningful lock —
-- CONCURRENTLY is unnecessary (and cannot run in a txn).

-- 1. slug — the stable app key (blockId), present on every publish request.
ALTER TABLE "app_review_agent_reports"
  ADD COLUMN IF NOT EXISTS "slug" TEXT NOT NULL;

-- 2. kind — report origin. DEFAULT 'onsite' matches the Prisma @default and lets
--    the (empty) table + any future onsite writer omit it. CHECK-constrained to
--    the two supported kinds (external/connect is a later phase).
ALTER TABLE "app_review_agent_reports"
  ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'onsite';
ALTER TABLE "app_review_agent_reports"
  DROP CONSTRAINT IF EXISTS "app_review_agent_reports_kind_check";
ALTER TABLE "app_review_agent_reports"
  ADD CONSTRAINT "app_review_agent_reports_kind_check"
  CHECK ("kind" IN ('onsite', 'external'));

-- 3. Drop the app-key XOR CHECK. app_block_id / oauth_client_id stay as nullable
--    INFORMATIONAL columns (app_block_id populated when the AppBlock already
--    exists, else null; oauth_client_id reserved for the external/connect flow).
--    No exactly-one invariant any more — slug is the key.
ALTER TABLE "app_review_agent_reports"
  DROP CONSTRAINT IF EXISTS "app_review_agent_reports_app_key_xor";

-- 4. Swap the per-app-key covering indexes for the slug-scoped one. The prior-
--    report lookup narrows to one app by slug, then filters status='complete' and
--    picks the semver-latest strictly-older version in-app.
DROP INDEX IF EXISTS "app_review_agent_reports_app_block_version_idx";
DROP INDEX IF EXISTS "app_review_agent_reports_oauth_client_version_idx";
CREATE INDEX IF NOT EXISTS "app_review_agent_reports_slug_version_idx"
  ON "app_review_agent_reports" ("slug", "version");

-- 5. Status CHECK gains 'cost-capped' (persisted verbatim from the runner).
ALTER TABLE "app_review_agent_reports"
  DROP CONSTRAINT IF EXISTS "app_review_agent_reports_status_check";
ALTER TABLE "app_review_agent_reports"
  ADD CONSTRAINT "app_review_agent_reports_status_check"
  CHECK ("status" IN ('running', 'complete', 'failed', 'torn-down', 'cost-capped'));

-- 6. Partial UNIQUE index: at most ONE `running` report per publish request. The
--    DB backstop for the double-provision guard — a concurrent second dispatch
--    for the same request cannot insert a second running row. Non-running rows
--    (complete/failed/torn-down/cost-capped) are unconstrained, so re-reviews and
--    history accumulate freely.
CREATE UNIQUE INDEX IF NOT EXISTS "app_review_agent_reports_running_pubreq_uq"
  ON "app_review_agent_reports" ("publish_request_id")
  WHERE "status" = 'running';
