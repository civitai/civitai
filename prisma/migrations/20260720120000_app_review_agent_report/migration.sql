-- ============================================================
-- App Blocks — agentic mod code-review report (P0 persistence layer)
-- ============================================================
-- Introduces app_review_agent_reports: one row per agent code-review of an app
-- version, keyed to the app (on-site app_blocks OR external OauthClient) + the
-- reviewed version, so the NEXT version's review can diff against the prior one
-- (the prior_report_id self-chain).
--
-- P0 = data model ONLY, fully DARK/INERT: NOTHING in the running image reads or
-- writes this table (no router, no REST handler, no job). It is additive and
-- read by nothing, so applying it ahead of / independent of the code that will
-- populate it is inert. Provisioning, the review UI, and the chat surface are
-- later phases.
--
-- ⚠️ MANUAL APPLY — per datapacket-talos CLAUDE.md DB rule #8 the main civitai
-- CNPG nvme0 DB does NOT auto-apply migrations (no prisma migrate deploy). This
-- file is committed for HISTORY ONLY; a HUMAN applies the SQL below per
-- environment (psql/retool). CI / deploy do NOT run it. Apply to BOTH:
--   1. prod nvme0   (the live civitai DB)
--   2. the dev clone
--
-- Idempotent: IF NOT EXISTS guards on the table + every index so a manual re-run
-- is a no-op. The table is brand-new + EMPTY, so plain CREATE INDEX takes no
-- meaningful lock — CONCURRENTLY is unnecessary (and cannot run in a txn). The
-- string enum uses a CHECK constraint (mirrors the app_listings.status pattern),
-- and a second CHECK enforces the app-key XOR (exactly one of app_block_id /
-- oauth_client_id set) at the DB.

-- ------------------------------------------------------------
-- app_review_agent_reports — per-review agent report, chained by version
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "app_review_agent_reports" (
  "id"                  TEXT PRIMARY KEY,                       -- arar_<ULID>
  -- The review (publish request) this report was generated for. DUAL-TARGET by
  -- construction (on-site = app_block_publish_requests.id pubreq_<ULID>; connect
  -- = app_listing_publish_requests.id alpr_<ULID>), so it is an indexed id, NOT
  -- a FK — resolved by kind in the service.
  "publish_request_id"  TEXT NOT NULL,
  -- App identity — EXACTLY ONE is set: app_block_id for an on-site App Block,
  -- oauth_client_id for an external / OAuth-connect app. The exactly-one
  -- invariant is enforced by the app_key_xor CHECK below (not merely by the
  -- reader). Plain indexed columns (no FK) so this dark P0 stays a
  -- self-contained additive island.
  "app_block_id"        TEXT,
  "oauth_client_id"     TEXT,
  -- The reviewed bundle's version (semver) + integrity hash.
  "version"             TEXT NOT NULL,
  "bundle_sha256"       TEXT NOT NULL,
  -- Agent-run lifecycle. CHECK-constrained below.
  "status"              TEXT NOT NULL DEFAULT 'running',
  -- The LLM that produced the review (NULL until the run reports one).
  "model"               TEXT,
  "started_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "completed_at"        TIMESTAMPTZ,
  -- Structured agent outputs (NULLABLE — populated as the run progresses).
  "code_review"         JSONB,
  "security_audit"      JSONB,
  "scope_verdicts"      JSONB,
  "summary_md"          TEXT,
  -- The prior version's report in the chain (self-reference). SET NULL so
  -- deleting an older report does not cascade-delete its successors.
  "prior_report_id"     TEXT REFERENCES "app_review_agent_reports"("id") ON DELETE SET NULL,
  -- LLM token accounting + total cost. Decimal(12,6): LLM costs are frequently
  -- sub-cent, so the repo's (10,2) money precision would round them away.
  "token_usage"         JSONB,
  "cost_usd"            NUMERIC(12, 6),
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "app_review_agent_reports_status_check"
    CHECK ("status" IN ('running', 'complete', 'failed', 'torn-down')),
  -- App-key XOR: EXACTLY ONE of app_block_id / oauth_client_id is set. Enforced
  -- at the DB (not just in the reader) so a future writer that sets BOTH is
  -- rejected — otherwise a report would surface under two apps (cross-app leak).
  -- Safe to add unconditionally: the table is brand-new + empty.
  CONSTRAINT "app_review_agent_reports_app_key_xor"
    CHECK (num_nonnulls("app_block_id", "oauth_client_id") = 1)
);

-- Per-app-key covering index (on-site vs connect). Narrows the candidate set to
-- one app; the reader still filters status='complete' and picks the semver-latest
-- older version IN-APP (neither status nor semver ordering is expressed here).
CREATE INDEX IF NOT EXISTS "app_review_agent_reports_app_block_version_idx"
  ON "app_review_agent_reports" ("app_block_id", "version");
CREATE INDEX IF NOT EXISTS "app_review_agent_reports_oauth_client_version_idx"
  ON "app_review_agent_reports" ("oauth_client_id", "version");
-- By-review lookup (getAgentReport).
CREATE INDEX IF NOT EXISTS "app_review_agent_reports_publish_request_idx"
  ON "app_review_agent_reports" ("publish_request_id");
