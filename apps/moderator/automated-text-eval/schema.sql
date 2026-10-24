-- Automated text relabel: a blind, human-labelled sample of Clavata "Automated" report hits.
-- MODERATOR database (internal_tools). Applied by hand; idempotent. Apply order: README.md.

CREATE TABLE IF NOT EXISTS text_relabel_item (
  id              bigserial PRIMARY KEY,
  -- What the page shows in place of the serial id, which would order items by snapshot run.
  token           uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  batch           text NOT NULL,
  report_id       integer NOT NULL,
  -- The one Clavata tag the labeler judges the text against.
  tag             text NOT NULL,
  -- 1 is labelled first; 2 is the rest of the pool, served only once wave 1 is exhausted.
  wave            smallint NOT NULL CHECK (wave IN (1, 2)),
  -- ReportEntity value (`$lib/reports`) or 'unknown', for the hand-off links.
  entity_type     text NOT NULL,
  entity_id       integer,
  -- Eval split group key: one author's texts never sit on both sides of a split. Never shown.
  author_id       integer,
  visibility      text NOT NULL CHECK (visibility IN ('public', 'private')),
  confidence      smallint NOT NULL,
  confidence_band text NOT NULL CHECK (confidence_band IN ('low', 'mid', 'high')),
  stratum_key     text NOT NULL,
  -- How many (report, tag) pairs the snapshot window held in this stratum, so a report can re-weight
  -- the sample to the true mix.
  cell_population integer NOT NULL CHECK (cell_population > 0),
  -- Null once purged. The labels outlive the text.
  text_value      text,
  flagged_at      timestamptz NOT NULL,
  purge_after     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, tag)
);

CREATE INDEX IF NOT EXISTS text_relabel_item_batch_idx ON text_relabel_item (batch);

CREATE TABLE IF NOT EXISTS text_relabel_answer (
  id              bigserial PRIMARY KEY,
  item_id         bigint NOT NULL REFERENCES text_relabel_item(id) ON DELETE CASCADE,
  labeler_id      integer NOT NULL,
  label           text NOT NULL CHECK (label IN ('clear_violation', 'borderline', 'false_positive', 'cannot_tell')),
  note            text CHECK (char_length(note) <= 1000),
  duration_ms     integer,
  -- First time this answer handed the case off. The page then links the report, so an edit after it
  -- (updated_at later than this) was not made blind.
  handed_off_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, labeler_id)
);

-- At most two labelers per item, for the same reason as relabel_answer_max_two: two labelers racing
-- for the last slot both pass an application-side count.
CREATE OR REPLACE FUNCTION text_relabel_answer_max_two() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM text_relabel_item WHERE id = NEW.item_id FOR UPDATE;
  IF (SELECT count(*) FROM text_relabel_answer WHERE item_id = NEW.item_id AND labeler_id <> NEW.labeler_id) >= 2 THEN
    RAISE EXCEPTION 'text relabel item % already has two labelers', NEW.item_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS text_relabel_answer_max_two ON text_relabel_answer;
CREATE TRIGGER text_relabel_answer_max_two
  BEFORE INSERT ON text_relabel_answer
  FOR EACH ROW EXECUTE FUNCTION text_relabel_answer_max_two();
