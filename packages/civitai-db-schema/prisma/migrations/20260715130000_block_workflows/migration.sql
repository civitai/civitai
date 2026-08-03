-- ============================================================
-- App Blocks — persistent block-generation output queue (G6, generic)
-- ============================================================
-- A durable READ-MODEL of the block-initiated generations a viewer has in
-- flight (and recently completed) for a given app block. Today a block's
-- generation "queue" lives only in the iframe's memory (it holds the
-- workflowIds and polls each), so it is LOST on reload / device switch. This
-- table lets a block rebuild that queue on load by asking the host for the
-- viewer's own recent workflows for the calling app block.
--
-- FULLY GENERIC — there is NO "generator" concept here. Any app block that
-- drives budgeted generation writes exactly one row per submit, keyed by the
-- orchestrator workflow id. The table carries NO generator/content columns:
-- content-author / bounty attribution already lives in block_spend_attribution
-- (G5). This is purely the (who, which app, which workflow, what status) queue
-- state.
--
-- WHY A DEDICATED TABLE (not block_spend_attribution / block_scope_invocations):
--   - block_spend_attribution is a MONEY/payout record (RESTRICT FKs, void /
--     confirm / paid-out lifecycle, only written for REAL fee-bearing spend).
--     The queue must record EVERY submit (incl. blue-only / cache-hit / 0-cost
--     gens) and is disposable, so it needs a different lifecycle + CASCADE FKs.
--   - block_scope_invocations is an append-only audit feed (one row per scope
--     call), not a per-workflow status row you UPDATE on completion.
-- Keeping the queue in its own table keeps each concern's invariants clean.
--
-- LIFECYCLE:
--   - INSERT at submit time (blocks.router.submitWorkflow), server-derived from
--     the VERIFIED block JWT (app_block_id, block_instance_id, user_id) + the
--     orchestrator workflow id + the submit-time status. Fire-and-forget: a
--     failed insert never breaks the generation (the Buzz was already spent and
--     the snapshot is the user-facing source of truth).
--   - UPDATE status/updated_at on the orchestrator completion callback
--     (/api/internal/blocks/workflow-completed), JOB_TOKEN-guarded + 7-day
--     idempotent. A missed update degrades to a stale status hint — the block
--     can always poll the orchestrator for the live status — so it is best-effort.
--   - The row is a disposable HINT, never the source of truth: CASCADE on both
--     FKs so deleting a user or an app block sweeps its queue rows.
--
-- ⚠️ MANUAL-APPLY (civitai DB rule #8): committed for history, NOT auto-applied.
--    A human runs this via psql/retool BEFORE the code that writes rows deploys,
--    on:
--      1. prod nvme0  (role=postgres CNPG cluster — the main civitai DB)
--      2. the dev clone (cnpg-cluster-dev, ns cnpg-database-dev)
--    The table is additive with no backfill, so the apply is order-safe (there
--    are zero readers until the G6 code deploys). Existing data is untouched.
--
-- ACCESS: this read-model is queried via raw SQL (dbRead.$queryRaw /
--    dbWrite.$executeRaw in block-workflows.service.ts) — there is
--    intentionally no Prisma delegate, so no client regen is required to ship it.

CREATE TABLE "block_workflows" (
  -- The orchestrator workflow id — the natural key. One row per submit; a
  -- re-poll / retry of the same workflow is idempotent (ON CONFLICT DO NOTHING
  -- at insert, an UPDATE ... WHERE workflow_id on completion).
  "workflow_id"       TEXT NOT NULL PRIMARY KEY,

  -- Server-derived from the verified block JWT. app_block_id is a real FK for
  -- deployed app blocks; the dev/live harness (synthetic app_block_id) does NOT
  -- write here (see the service), so the FK never sees a synthetic id.
  "app_block_id"      TEXT NOT NULL REFERENCES "app_blocks"("id") ON DELETE CASCADE,
  "block_instance_id" TEXT NOT NULL,
  "user_id"           INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,

  -- The block-contract workflow status: the same flattened states
  -- snapshotFromWorkflow surfaces to the iframe.
  "status"            TEXT NOT NULL,

  "submitted_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "block_workflows_status_check"
    CHECK ("status" IN ('pending', 'processing', 'succeeded', 'failed', 'expired', 'canceled'))
);

-- The one read path: "give me MY recent workflows for THIS app block", newest
-- first, keyset-paginated on (submitted_at DESC, workflow_id DESC). user_id +
-- app_block_id are both bound server-side from the token, so this composite
-- index serves the exact predicate + ordering.
CREATE INDEX "block_workflows_user_app_idx"
  ON "block_workflows" ("user_id", "app_block_id", "submitted_at" DESC, "workflow_id" DESC);
