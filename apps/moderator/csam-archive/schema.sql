-- One row per csam-archiver run: what it collected, as counts, and whether verify passed. Written by
-- the archiver (a CronJob outside this repo), read by the moderator app's CSAM archive page.
--
-- Lives in the `internal_tools` database (MODERATOR_DATABASE_URL), beside `page_access_change`.
--
-- 🔴 APPLIED BY HAND, in each environment, AS THE APPLICATION ROLE (`internal_tools`), so the app owns
-- the table. Apply it before the archiver is given RUN_LOG_DATABASE_URL; the archiver logs a warning
-- and carries on when the table is missing, so a run is never lost to it.
--
--   psql "$MODERATOR_DATABASE_URL" -f apps/moderator/csam-archive/schema.sql
--
-- The archiver connects as its own login, which may only insert and update rows here. Create it once
-- (password from the secret store, never this file), then run the GRANTs below:
--   CREATE ROLE csam_archiver LOGIN PASSWORD '...';
--
-- Idempotent: safe to re-run.

\set ON_ERROR_STOP on

-- 🔴 COUNTS ONLY. No file keys, paths, hashes or content: anyone who can open the page reads it.
CREATE TABLE IF NOT EXISTS csam_archive_run (
  id               bigserial   PRIMARY KEY,
  -- `report` archives one CsamReport; `preservation` archives a user for a preservation request.
  kind             text        NOT NULL,
  report_id        integer,
  preservation_id  text,
  user_id          integer     NOT NULL,
  mode             text        NOT NULL,
  -- Checklist items the run was limited to; NULL is the whole checklist.
  scope            smallint[],
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  -- `running` until the run ends. A row left `running` past a claim TTL is a run that died.
  outcome          text        NOT NULL DEFAULT 'running',
  -- The manifest summary: { ok, planned, failed, external, total, skipped, byItem: { "<item>": { entries, rows, bytes } } }.
  summary          jsonb,
  -- { ok, expected, found, mismatches, failedEntries }; NULL for a dry run.
  verify           jsonb,
  -- Whether this run set "CsamReport"."archivedAt".
  archived         boolean     NOT NULL DEFAULT false,
  -- An error class name, never a message: messages can carry keys.
  error            text,
  archiver_version text
);

CREATE INDEX IF NOT EXISTS csam_archive_run_report_idx ON csam_archive_run (report_id, started_at DESC);
CREATE INDEX IF NOT EXISTS csam_archive_run_started_idx ON csam_archive_run (started_at DESC);

-- `ADD CONSTRAINT` has no `IF NOT EXISTS`, so each is guarded by name to keep the file re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'csam_archive_run_kind_check') THEN
    ALTER TABLE csam_archive_run ADD CONSTRAINT csam_archive_run_kind_check CHECK (
      (kind = 'report' AND report_id IS NOT NULL)
      OR (kind = 'preservation' AND preservation_id IS NOT NULL)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'csam_archive_run_mode_check') THEN
    ALTER TABLE csam_archive_run ADD CONSTRAINT csam_archive_run_mode_check
      CHECK (mode IN ('dry-run', 'write'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'csam_archive_run_outcome_check') THEN
    ALTER TABLE csam_archive_run ADD CONSTRAINT csam_archive_run_outcome_check
      CHECK (outcome IN ('running', 'collected', 'verified', 'failed', 'error'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'csam_archiver') THEN
    GRANT INSERT, UPDATE ON csam_archive_run TO csam_archiver;
    -- UPDATE ... WHERE id = $1 needs SELECT on the column it filters by.
    GRANT SELECT (id) ON csam_archive_run TO csam_archiver;
    GRANT USAGE ON SEQUENCE csam_archive_run_id_seq TO csam_archiver;
  END IF;
END $$;
