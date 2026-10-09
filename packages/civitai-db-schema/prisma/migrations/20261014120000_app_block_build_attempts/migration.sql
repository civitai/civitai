-- ============================================================
-- App Blocks — build attempt history (app_block_build_attempts)
-- ============================================================
-- One row per build-run event:
--   * status 'triggered'  — civitai started a run (approve, moderator retrigger,
--                           or a review preview), with the run id the build
--                           service returned;
--   * status 'succeeded' / 'failed' — an applied build callback for that run,
--                           with the optional failed step, the build service's
--                           reason, and the failure class civitai derived.
--
-- app_block_publish_requests keeps ONE mutable deploy_state per version, so it
-- cannot say which run a callback belongs to or what happened on earlier runs.
-- This table can, and the build callbacks use the 'triggered' rows to ignore a
-- late failure from an OLDER run instead of letting it overwrite a newer run's
-- 'building'. An ignored failure writes no row.
--
-- Append-only: a callback delivered more than once appends one row per
-- delivery. Readers take the newest row per publish request.
--
-- Applied MANUALLY per environment; nothing auto-applies it. The application
-- tolerates the table being absent: every read and write of it is best-effort,
-- and the build callback's deploy_state update does not depend on it. Until it is
-- applied, no attempt history is kept, the stale-run guard is inactive, and the
-- UI keeps using the text-based fallback classifier.
--
-- Idempotent: safe to run more than once.
--
-- No foreign key to app_block_publish_requests, deliberately: rows are written
-- best-effort from the build callback, publish_request_id is NULL when the
-- callback's (slug, sha) matches no approved request, and history should not
-- block or cascade from request deletes.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "app_block_build_attempts" (
  "id"                 SERIAL       PRIMARY KEY,
  "publish_request_id" TEXT,
  "slug"               TEXT         NOT NULL,
  "sha"                TEXT         NOT NULL,
  "run_id"             TEXT,
  "mode"               TEXT         NOT NULL,
  "status"             TEXT         NOT NULL,
  "failed_step"        TEXT,
  "failed_reason"      TEXT,
  "failure_class"      TEXT,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "app_block_build_attempts_mode_check"
    CHECK ("mode" IN ('build', 'review')),
  CONSTRAINT "app_block_build_attempts_status_check"
    CHECK ("status" IN ('triggered', 'succeeded', 'failed'))
);

-- Latest attempt for a publish request (History tab, moderator Approved tab).
CREATE INDEX IF NOT EXISTS "app_block_build_attempts_request_idx"
  ON "app_block_build_attempts" ("publish_request_id", "mode", "created_at" DESC);

-- Latest triggered run for a version (the stale-run guard in the build callbacks).
CREATE INDEX IF NOT EXISTS "app_block_build_attempts_version_idx"
  ON "app_block_build_attempts" ("mode", "slug", "sha", "created_at" DESC);

COMMIT;
