-- Highlight terms, per label, editable without a deploy.
--
-- These were a hardcoded constant. That was wrong for two reasons: the vocabulary that matters
-- differs per label (youth nouns mean nothing when reviewing a sexual-content label), and the list
-- gets edited constantly as tuning surfaces spellings moderators miss. A constant in the repo makes
-- every one of those edits a code change.
--
-- CASCADE here, unlike the judgement tables: terms are owned by their label and mean nothing
-- without it, whereas a judgement is evidence that must outlive a label being retired.

CREATE TABLE IF NOT EXISTS label_term (
  id          bigserial PRIMARY KEY,
  label       text NOT NULL REFERENCES label_def(name) ON DELETE CASCADE,
  term        text NOT NULL,
  -- trigger: argues FOR the label firing.  counter: argues against.
  -- soft:    weak on its own, meaningful when several stack.
  kind        text NOT NULL CHECK (kind IN ('trigger', 'counter', 'soft')),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (label, term)
);

CREATE INDEX IF NOT EXISTS label_term_label_idx ON label_term (label);
