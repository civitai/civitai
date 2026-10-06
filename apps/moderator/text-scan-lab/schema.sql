-- Text-scan prompt lab: drafts, test sets, runs. MODERATOR database. Applied by hand; idempotent.

CREATE TABLE IF NOT EXISTS text_scan_prompt_draft (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  -- { "base": "...", "label:nsfw": "...", ... }: only the keys the draft changes; the rest run active.
  prompts     jsonb NOT NULL DEFAULT '{}'::jsonb,
  note        text CHECK (char_length(note) <= 2000),
  created_by  integer NOT NULL,
  -- Millisecond precision: updated_at is the edit-conflict token and round-trips through a JS Date.
  created_at  timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_by  integer NOT NULL,
  updated_at  timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds', now()),
  published_at timestamptz,
  published_prompt_ids jsonb,
  -- 'working': a moderator's unnamed, auto-saved changes, at most one each. 'proposed': named, shared.
  kind        text NOT NULL DEFAULT 'proposed' CHECK (kind IN ('working', 'proposed'))
);
ALTER TABLE text_scan_prompt_draft ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'proposed' CHECK (kind IN ('working', 'proposed'));
CREATE UNIQUE INDEX IF NOT EXISTS text_scan_prompt_draft_working_idx ON text_scan_prompt_draft (created_by) WHERE kind = 'working';

CREATE TABLE IF NOT EXISTS text_scan_test_set (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND 100),
  description text CHECK (char_length(description) <= 2000),
  created_by  integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE IF NOT EXISTS text_scan_test_case (
  id            bigserial PRIMARY KEY,
  set_id        bigint NOT NULL REFERENCES text_scan_test_set(id) ON DELETE CASCADE,
  -- The text-scan entity type whose label set and headings the case runs with.
  entity_type   text NOT NULL,
  -- Null for free text.
  entity_id     integer,
  author_id     integer,
  -- [{ "heading": "...", "text": "..." }], snapshotted when added. Null once the source is deleted.
  fields        jsonb,
  text_hash     text NOT NULL,
  -- nsfw: {"min":"pg13","max":"r"}; poi/minor/scam: true | false; absent key = don't score.
  expected      jsonb NOT NULL DEFAULT '{}'::jsonb,
  synthetic     boolean NOT NULL DEFAULT false,
  note          text CHECK (char_length(note) <= 1000),
  source_deleted_at timestamptz,
  -- ChatMessage: the id of every message in the snapshot, so a purge sees any one of them go.
  source_ids    jsonb,
  added_by      integer NOT NULL,
  added_at      timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (set_id, entity_type, entity_id)
);
ALTER TABLE text_scan_test_case ADD COLUMN IF NOT EXISTS source_ids jsonb;
CREATE INDEX IF NOT EXISTS text_scan_test_case_set_idx ON text_scan_test_case (set_id);
CREATE INDEX IF NOT EXISTS text_scan_test_case_entity_idx ON text_scan_test_case (entity_type, entity_id) WHERE entity_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS text_scan_test_run (
  id          bigserial PRIMARY KEY,
  set_id      bigint NOT NULL REFERENCES text_scan_test_set(id) ON DELETE CASCADE,
  -- 'active' or a draft id.
  version     text NOT NULL,
  draft_id    bigint REFERENCES text_scan_prompt_draft(id) ON DELETE SET NULL,
  draft_updated_at timestamptz,
  -- The draft's overrides as they ran (null for active), so a re-run repeats them after the draft
  -- changes or is deleted. The keys it did not override ran active, at the ids in prompt_ids.
  prompts     jsonb,
  -- { "base": 12, "nsfw": 0, ... } as the harness reported them; 0 is an override.
  prompt_ids  jsonb,
  model       text,
  -- The harness config's thinking flag the run scanned with; a re-run refuses once it changes.
  thinking    boolean,
  status      text NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  -- Per-label totals as of finishing. Pages rescore from the results against each case's current
  -- expectation, so this goes stale when a case is relabelled.
  totals      jsonb,
  run_by      integer NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  -- Progress of the scan in flight (a run or a re-run of its errors), which runs after the request
  -- that started it: cases it scans, cases scanned so far, and when the last chunk landed. A running
  -- run whose progress_at goes stale was interrupted.
  scan_total  integer,
  scan_done   integer NOT NULL DEFAULT 0,
  progress_at timestamptz
);
ALTER TABLE text_scan_test_run ADD COLUMN IF NOT EXISTS thinking boolean;
ALTER TABLE text_scan_test_run ADD COLUMN IF NOT EXISTS scan_total integer;
ALTER TABLE text_scan_test_run ADD COLUMN IF NOT EXISTS scan_done integer NOT NULL DEFAULT 0;
ALTER TABLE text_scan_test_run ADD COLUMN IF NOT EXISTS progress_at timestamptz;
CREATE INDEX IF NOT EXISTS text_scan_test_run_set_idx ON text_scan_test_run (set_id, started_at DESC);

CREATE TABLE IF NOT EXISTS text_scan_test_result (
  run_id      bigint NOT NULL REFERENCES text_scan_test_run(id) ON DELETE CASCADE,
  case_id     bigint NOT NULL REFERENCES text_scan_test_case(id) ON DELETE CASCADE,
  status      text NOT NULL CHECK (status IN ('ok', 'error', 'skipped')),
  -- parse.output on ok; { error } otherwise.
  output      jsonb,
  workflow_id text,
  PRIMARY KEY (run_id, case_id)
);
CREATE INDEX IF NOT EXISTS text_scan_test_result_case_idx ON text_scan_test_result (case_id);
