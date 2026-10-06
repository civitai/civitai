-- Text-scan prompt lab: drafts, test sets, runs. MODERATOR database. Applied by hand; idempotent.

CREATE TABLE IF NOT EXISTS text_scan_prompt_draft (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  -- { "base": "...", "label:nsfw": "...", ... }: only the keys the draft changes; the rest run active.
  prompts     jsonb NOT NULL DEFAULT '{}'::jsonb,
  note        text CHECK (char_length(note) <= 2000),
  created_by  integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  integer NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Set when published; a published draft is read-only.
  published_at timestamptz,
  published_prompt_ids jsonb
);

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
  added_by      integer NOT NULL,
  added_at      timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (set_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS text_scan_test_case_set_idx ON text_scan_test_case (set_id);
CREATE INDEX IF NOT EXISTS text_scan_test_case_entity_idx ON text_scan_test_case (entity_type, entity_id) WHERE entity_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS text_scan_test_run (
  id          bigserial PRIMARY KEY,
  set_id      bigint NOT NULL REFERENCES text_scan_test_set(id) ON DELETE CASCADE,
  -- 'active' or a draft id; prompt_ids/prompts record exactly what ran.
  version     text NOT NULL,
  draft_id    bigint REFERENCES text_scan_prompt_draft(id) ON DELETE SET NULL,
  draft_updated_at timestamptz,
  prompt_ids  jsonb,
  model       text,
  status      text NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  totals      jsonb,
  run_by      integer NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS text_scan_test_run_set_idx ON text_scan_test_run (set_id, started_at DESC);

CREATE TABLE IF NOT EXISTS text_scan_test_result (
  run_id      bigint NOT NULL REFERENCES text_scan_test_run(id) ON DELETE CASCADE,
  case_id     bigint NOT NULL REFERENCES text_scan_test_case(id) ON DELETE CASCADE,
  status      text NOT NULL CHECK (status IN ('ok', 'error', 'skipped')),
  -- parse.output on ok; { error } otherwise.
  output      jsonb,
  workflow_id text,
  -- { "nsfw": true, "poi": false, ... } per scored label.
  correct     jsonb,
  PRIMARY KEY (run_id, case_id)
);
