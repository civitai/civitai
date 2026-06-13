-- W5 v0.5: per-install version pin + scope-invocation audit log.
--
-- Two unrelated-looking changes ship together because they're both
-- /apps/installed extensions that landed in the same session.
--
-- 1) ModelBlockInstall.pinned_version: NULL = use the AppBlock's current
--    approved version (the existing behavior). A semver string = the host
--    loads THAT version's manifest from app_block_publish_requests instead
--    of app_blocks.manifest. iframe.src is still the live image — there's
--    one image per slug today. Wired so W2-v1 multi-version hosting can
--    route on this column without another migration.
--
-- 2) BlockScopeInvocation: one row per successful scope-gated API call
--    (block_scope.middleware.ts). Surfaces the W5 "audit log of scope
--    usage" on /apps/installed.tsx's Activity tab — interleaved with
--    block_buzz_attribution rows so the user sees both paid and free
--    actions in one timeline.
--
--    `block_instance_id` is intentionally NOT an FK — same rationale as
--    block_buzz_attribution: synthetic ids (pdb_, bus_pub_, bus_view_)
--    don't have a model_block_installs row to point at. Resolution at
--    read time via BlockRegistry.resolveBlockInstance.

-- Track the pinned version per install. NULL = always use latest approved.
ALTER TABLE "model_block_installs"
  ADD COLUMN "pinned_version" TEXT;

-- Audit log of every scope-gated API call.
CREATE TABLE "block_scope_invocations" (
    "id" BIGSERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "app_block_id" TEXT NOT NULL,
    "block_instance_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "status_code" SMALLINT NOT NULL,
    "invoked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "block_scope_invocations_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "block_scope_invocations"
  ADD CONSTRAINT "block_scope_invocations_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "block_scope_invocations"
  ADD CONSTRAINT "block_scope_invocations_app_block_id_fkey"
  FOREIGN KEY ("app_block_id") REFERENCES "app_blocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Primary query path: /apps/installed Activity tab — user's recent
-- invocations newest first.
CREATE INDEX "bsi_user_invoked_idx"
  ON "block_scope_invocations"("user_id", "invoked_at" DESC, "id" DESC);

-- Secondary: per-app filter (future work; cheap to include now).
CREATE INDEX "bsi_app_block_invoked_idx"
  ON "block_scope_invocations"("app_block_id", "invoked_at" DESC);
