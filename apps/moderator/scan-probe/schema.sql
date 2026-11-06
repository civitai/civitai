-- One row per image a moderator ran through the scan probe (`/images/scan-probe`). It is the audit
-- record, the key the result poll reads, and the count the rate limits are taken from.
--
-- Lives in the `internal_tools` database (MODERATOR_DATABASE_URL), beside `page_access_change`.
--
-- 🔴 APPLIED BY HAND, in each environment — no runner, no auto-apply on deploy. Apply it BEFORE the
-- release that ships the code: the probe refuses to submit anything it cannot record, so until this
-- table exists the page cannot run a scan.
--
--   psql "$MODERATOR_DATABASE_URL" -f apps/moderator/scan-probe/schema.sql
--
-- 🔴 AS THE APPLICATION ROLE (`internal_tools`), which is what that URL connects as. Applied as
-- `postgres` the table is postgres-owned and the app cannot write it. Recovery is ownership:
--   ALTER TABLE    image_scan_probe_run        OWNER TO internal_tools;
--   ALTER SEQUENCE image_scan_probe_run_id_seq OWNER TO internal_tools;
--
-- Idempotent: safe to re-run.

\set ON_ERROR_STOP on

-- A row is written `pending` BEFORE the submit, then set `submitted` (with its workflow) or
-- `submit-failed`. A row left `pending` is a submit whose outcome is unknown.
CREATE TABLE IF NOT EXISTS image_scan_probe_run (
  id              bigserial   PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- 🔴 The user ID, never a username — a username is reassignable.
  moderator_id    integer     NOT NULL,
  image_id        integer     NOT NULL,
  status          text        NOT NULL DEFAULT 'pending',
  workflow_id     text,
  -- The orchestrator's status once it is terminal; null while it runs.
  workflow_status text,
  completed_at    timestamptz,
  -- The verdict the scan returned.
  nsfw_level      text,
  blocked_reason  text,
  csam            boolean,
  -- Whether the orchestrator answered from a verdict it already held for these bytes. The workflow
  -- response does not say, so 'unknown' until it does.
  cached          text        NOT NULL DEFAULT 'unknown',
  -- 🔴 A blocked or failed scan trips the probe's breaker: no further probe runs while any tripped
  -- row has no reset. A block can strike the account the probe submits as, and strikes never expire.
  tripped           boolean     NOT NULL DEFAULT false,
  breaker_reset_at  timestamptz,
  breaker_reset_by  integer
);

CREATE INDEX IF NOT EXISTS image_scan_probe_run_moderator_created
  ON image_scan_probe_run (moderator_id, created_at);
CREATE INDEX IF NOT EXISTS image_scan_probe_run_created
  ON image_scan_probe_run (created_at);
CREATE INDEX IF NOT EXISTS image_scan_probe_run_tripped
  ON image_scan_probe_run (id) WHERE tripped AND breaker_reset_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'image_scan_probe_run'::regclass AND conname = 'image_scan_probe_run_status_valid') THEN
    ALTER TABLE image_scan_probe_run ADD CONSTRAINT image_scan_probe_run_status_valid
      CHECK (status IN ('pending', 'submitted', 'submit-failed'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'image_scan_probe_run'::regclass AND conname = 'image_scan_probe_run_cached_valid') THEN
    ALTER TABLE image_scan_probe_run ADD CONSTRAINT image_scan_probe_run_cached_valid
      CHECK (cached IN ('yes', 'no', 'unknown'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'image_scan_probe_run'::regclass AND conname = 'image_scan_probe_run_workflow_when_submitted') THEN
    ALTER TABLE image_scan_probe_run ADD CONSTRAINT image_scan_probe_run_workflow_when_submitted
      CHECK (status <> 'submitted' OR workflow_id IS NOT NULL);
  END IF;
END
$$;
