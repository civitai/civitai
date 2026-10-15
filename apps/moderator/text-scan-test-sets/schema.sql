-- Text-scan test sets: saved cases with expected verdicts, and scored runs of prompt states over them.
-- MODERATOR database. Applied by hand; idempotent. Apply order: README.md.

CREATE TABLE IF NOT EXISTS text_scan_test_set (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND 100),
  description text CHECK (char_length(description) <= 2000),
  workspace   text NOT NULL CHECK (workspace IN ('prompts', 'modelRules')),
  created_by  integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Archived, never deleted, so its run history survives.
  archived_at timestamptz
);

CREATE TABLE IF NOT EXISTS text_scan_test_case (
  id                bigserial PRIMARY KEY,
  set_id            bigint NOT NULL REFERENCES text_scan_test_set(id) ON DELETE CASCADE,
  entity_type       text NOT NULL,
  entity_id         integer,
  author_id         integer,
  -- Import key for rows without an entity id.
  source_ref        text CHECK (char_length(source_ref) BETWEEN 1 AND 200),
  -- [{ "heading": "...", "text": "..." }]. Null once the source entity or author is deleted.
  fields            jsonb,
  text_hash         text NOT NULL,
  -- An absent key means "don't score that label".
  expected          jsonb NOT NULL DEFAULT '{}'::jsonb,
  note              text CHECK (char_length(note) <= 1000),
  origin            text NOT NULL CHECK (origin IN ('try', 'matches', 'import')),
  source_deleted_at timestamptz,
  added_by          integer NOT NULL,
  added_at          timestamptz NOT NULL DEFAULT now(),
  updated_by        integer NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (fields IS NOT NULL OR source_deleted_at IS NOT NULL),
  UNIQUE (set_id, entity_type, entity_id),
  UNIQUE (set_id, source_ref)
);
CREATE INDEX IF NOT EXISTS text_scan_test_case_set_idx ON text_scan_test_case (set_id);
CREATE INDEX IF NOT EXISTS text_scan_test_case_entity_idx ON text_scan_test_case (entity_type, entity_id);
-- A free text (no entity, no source ref) is keyed by its hash; upsertCase targets this predicate.
CREATE UNIQUE INDEX IF NOT EXISTS text_scan_test_case_free_text_key
  ON text_scan_test_case (set_id, entity_type, text_hash)
  WHERE entity_id IS NULL AND source_ref IS NULL;

-- One row per side: one prompt state over one set.
CREATE TABLE IF NOT EXISTS text_scan_test_run (
  id               bigserial PRIMARY KEY,
  set_id           bigint NOT NULL REFERENCES text_scan_test_set(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('baseline', 'draft')),
  -- Shared by the runs one start queued; the concurrency limits count starts, not rows.
  start_id         uuid NOT NULL,
  baseline_run_id  bigint,
  -- Cases with a higher id were added after the run started and are not part of it.
  max_case_id      bigint NOT NULL,
  -- Harness keys ({ "base": 12, "nsfw": 40 }); 0 where the draft overrides the key.
  prompt_ids       jsonb NOT NULL,
  prompt_overrides jsonb,
  rule_overrides   jsonb,
  rule_state       jsonb,
  rule_state_hash  text,
  model            text NOT NULL,
  thinking         boolean NOT NULL,
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'cancelling', 'done', 'cancelled', 'failed')),
  failure          text CHECK (char_length(failure) <= 2000),
  case_total       integer NOT NULL DEFAULT 0,
  case_done        integer NOT NULL DEFAULT 0,
  error_count      integer NOT NULL DEFAULT 0,
  lease_owner      text,
  heartbeat_at     timestamptz,
  totals           jsonb,
  -- Who started the run's latest pass (a re-run of errors or a baseline top-up moves it).
  run_by           integer NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  expires_at       timestamptz,
  CHECK (kind = 'draft' OR (prompt_overrides IS NULL AND rule_overrides IS NULL AND expires_at IS NULL))
);
CREATE INDEX IF NOT EXISTS text_scan_test_run_set_idx ON text_scan_test_run (set_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS text_scan_test_run_status_idx ON text_scan_test_run (status);

CREATE TABLE IF NOT EXISTS text_scan_test_result (
  run_id           bigint NOT NULL REFERENCES text_scan_test_run(id) ON DELETE CASCADE,
  case_id          bigint NOT NULL REFERENCES text_scan_test_case(id) ON DELETE CASCADE,
  status           text NOT NULL CHECK (status IN ('ok', 'error', 'skipped')),
  -- The verdict as the harness returned it. Nulled when the case is wiped: a reason can quote the text.
  output           jsonb,
  literal_rule_ids jsonb,
  workflow_id      text,
  error            text CHECK (char_length(error) <= 2000),
  segments         integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, case_id)
);
CREATE INDEX IF NOT EXISTS text_scan_test_result_case_idx ON text_scan_test_result (case_id);
