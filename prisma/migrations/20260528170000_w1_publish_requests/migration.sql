-- ============================================================
-- App Blocks W1 v0 Phase 1 — publish-request flow
-- ============================================================
-- Replaces the W12 direct-git-push developer flow with a UI-mediated
-- publish-request + moderator-review workflow. Devs upload a ZIP via
-- /apps/submit; mods approve/reject via /apps/review; on approve the
-- platform uploads to Forgejo server-side and the existing Tekton build
-- chain fires.
--
-- This migration adds the `app_block_publish_requests` table that backs
-- the queue. No changes to `app_blocks` — the row gets created/updated
-- by the `approveRequest` mutation rather than by `submitApp`.
--
-- Manual application (per CLAUDE.md gotcha #14):
--   kubectl exec -i -n cnpg-database cnpg-cluster-nvme0-N -- psql \
--     -U postgres -d civitai -v ON_ERROR_STOP=1 --single-transaction \
--     < prisma/migrations/20260528170000_w1_publish_requests/migration.sql

CREATE TABLE IF NOT EXISTS "app_block_publish_requests" (
  "id"                      TEXT        PRIMARY KEY,
  "app_block_id"            TEXT        NULL REFERENCES "app_blocks"("id") ON DELETE SET NULL,
  "slug"                    TEXT        NOT NULL,
  "submitted_by_user_id"    INTEGER     NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "submitted_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "version"                 TEXT        NOT NULL,
  "manifest"                JSONB       NOT NULL,
  "bundle_key"              TEXT        NOT NULL,
  "bundle_sha256"           TEXT        NOT NULL,
  "bundle_size_bytes"       BIGINT      NOT NULL,
  "file_summary"            JSONB       NOT NULL,
  "manifest_diff_summary"   JSONB       NOT NULL,
  "status"                  TEXT        NOT NULL,
  "reviewed_by_user_id"     INTEGER     NULL REFERENCES "User"("id") ON DELETE SET NULL,
  "reviewed_at"             TIMESTAMPTZ NULL,
  "rejection_reason"        TEXT        NULL,
  "approval_notes"          TEXT        NULL,
  "forgejo_commit_sha"      TEXT        NULL,
  "created_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "app_block_publish_requests_status_check"
    CHECK ("status" IN ('pending', 'approved', 'rejected', 'withdrawn')),

  -- Once reviewed, both reviewer + reviewed_at must be set together.
  CONSTRAINT "app_block_publish_requests_review_pair_check"
    CHECK (
      ("status" IN ('pending', 'withdrawn'))
      OR ("reviewed_by_user_id" IS NOT NULL AND "reviewed_at" IS NOT NULL)
    ),

  -- Rejection reason required when status='rejected'.
  CONSTRAINT "app_block_publish_requests_rejection_reason_check"
    CHECK ("status" <> 'rejected' OR "rejection_reason" IS NOT NULL),

  -- Forgejo commit SHA must be set when approved (post-Forgejo-upload).
  CONSTRAINT "app_block_publish_requests_approved_forgejo_check"
    CHECK ("status" <> 'approved' OR "forgejo_commit_sha" IS NOT NULL)
);

-- Mod queue: oldest pending first; the partial index keeps it small.
CREATE INDEX IF NOT EXISTS "app_block_publish_requests_queue_idx"
  ON "app_block_publish_requests" ("status", "submitted_at" DESC);

-- Per-app version history: for `/apps/<slug>` page showing all versions.
CREATE INDEX IF NOT EXISTS "app_block_publish_requests_app_history_idx"
  ON "app_block_publish_requests" ("app_block_id", "submitted_at" DESC);

-- Dev's "my submissions" page.
CREATE INDEX IF NOT EXISTS "app_block_publish_requests_my_submissions_idx"
  ON "app_block_publish_requests" ("submitted_by_user_id", "status");

-- "Is this slug already claimed (pending)?" check on first-version submit.
CREATE INDEX IF NOT EXISTS "app_block_publish_requests_slug_idx"
  ON "app_block_publish_requests" ("slug", "status");

-- Bundle dedup: if two requests hit with the same SHA, we can cheap-check.
CREATE INDEX IF NOT EXISTS "app_block_publish_requests_bundle_sha_idx"
  ON "app_block_publish_requests" ("bundle_sha256");

-- updated_at trigger (matches the convention used elsewhere — Prisma's
-- @updatedAt is a client-side hint, not a DB constraint).
CREATE OR REPLACE FUNCTION "app_block_publish_requests_set_updated_at"()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updated_at" = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "app_block_publish_requests_updated_at_trigger"
  ON "app_block_publish_requests";

CREATE TRIGGER "app_block_publish_requests_updated_at_trigger"
  BEFORE UPDATE ON "app_block_publish_requests"
  FOR EACH ROW EXECUTE FUNCTION "app_block_publish_requests_set_updated_at"();
