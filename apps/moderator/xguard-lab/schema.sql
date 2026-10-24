-- XGuard label lab: standalone Postgres schema.
--
-- Deliberately has NO foreign keys into the Civitai database. userId and
-- promptHash are carried as plain values so this can live in its own instance
-- (local docker now, its own cluster instance later) without coupling.
--
-- The unit of work is a (sample, label) pair: one prompt judged for one label.
-- A prompt sampled once can be judged for age today and for sexual content next
-- month without being re-sampled.

CREATE TABLE IF NOT EXISTS label_def (
  name          text PRIMARY KEY,
  description   text NOT NULL,
  -- Free text so a label can be retired without deleting its history.
  status        text NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Every revision of a label's policy prose. Judgements point at the exact
-- revision that produced them, so changing a policy never silently invalidates
-- or rewrites past results.
CREATE TABLE IF NOT EXISTS label_policy (
  id            bigserial PRIMARY KEY,
  label         text NOT NULL REFERENCES label_def(name) ON DELETE CASCADE,
  version       int NOT NULL,
  policy        text NOT NULL,
  threshold     real NOT NULL,
  action        text NOT NULL DEFAULT 'Scan',
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (label, version)
);

-- A prompt pulled from orchestration.xguardPromptResults (or anywhere else).
CREATE TABLE IF NOT EXISTS sample (
  id                bigserial PRIMARY KEY,
  -- Int64 in ClickHouse. Null when a sample did not come from that table.
  prompt_hash       bigint,
  source            text NOT NULL DEFAULT 'xguardPromptResults',
  -- Which sampling run produced this, so a batch can be evaluated as a unit.
  batch             text NOT NULL,
  user_id           int,
  positive_prompt   text NOT NULL,
  negative_prompt   text,
  -- Scores XGuard had at sample time, as a label -> score object.
  live_scores       jsonb,
  prompt_created_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch, prompt_hash)
);

CREATE INDEX IF NOT EXISTS sample_batch_idx ON sample (batch);
CREATE INDEX IF NOT EXISTS sample_prompt_hash_idx ON sample (prompt_hash);

-- What a model said about (sample, label). Covers both XGuard and the AI rater;
-- `source` distinguishes them and `model` records which one.
CREATE TABLE IF NOT EXISTS machine_judgement (
  id            bigserial PRIMARY KEY,
  sample_id     bigint NOT NULL REFERENCES sample(id) ON DELETE CASCADE,
  label         text NOT NULL,
  source        text NOT NULL CHECK (source IN ('xguard', 'ai')),
  model         text,
  -- Set for XGuard. The AI rater returns a verdict, not a probability.
  score         real,
  verdict       boolean NOT NULL,
  reason        text,
  -- Character spans worth highlighting, as [{start, end, field, kind}].
  highlights    jsonb,
  policy_id     bigint REFERENCES label_policy(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS machine_judgement_sample_idx ON machine_judgement (sample_id, label);
CREATE INDEX IF NOT EXISTS machine_judgement_lookup_idx ON machine_judgement (label, source, created_at DESC);

-- A human agreeing or disagreeing with a machine judgement. The whole point of
-- the review UI: confirming a decision is faster and more accurate than forming
-- one from scratch, so we store the agreement, not a fresh verdict.
--
-- `verdict` is the resulting ground truth either way: on agreement it copies the
-- machine verdict, on disagreement it is the opposite. Storing it explicitly
-- means the training set is one column, not a join and a conditional.
CREATE TABLE IF NOT EXISTS human_judgement (
  id                    bigserial PRIMARY KEY,
  sample_id             bigint NOT NULL REFERENCES sample(id) ON DELETE CASCADE,
  label                 text NOT NULL,
  -- Which machine judgement was on screen. Null if reviewed cold.
  reviewed_judgement_id bigint REFERENCES machine_judgement(id) ON DELETE SET NULL,
  agreed                boolean,
  verdict               boolean NOT NULL,
  -- Reviewer's own note. Rare, and worth reading when present.
  note                  text,
  reviewer_id           int NOT NULL,
  -- Wall-clock seconds on the item. A reviewer averaging 2s is rubber-stamping.
  duration_ms           int,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- One verdict per reviewer per (sample, label); re-reviewing overwrites.
  UNIQUE (sample_id, label, reviewer_id)
);

CREATE INDEX IF NOT EXISTS human_judgement_label_idx ON human_judgement (label, created_at DESC);

-- Convenience view: the current ground truth per (sample, label), with the
-- number of reviewers behind it. Single-reviewer labels were the binding
-- constraint on the last tuning pass, so agreement count is surfaced here
-- rather than left to be recomputed by every consumer.
CREATE OR REPLACE VIEW ground_truth AS
SELECT
  h.sample_id,
  h.label,
  bool_or(h.verdict)                             AS any_true,
  count(*)                                       AS reviewer_count,
  count(*) FILTER (WHERE h.verdict)              AS true_count,
  count(*) FILTER (WHERE NOT h.verdict)          AS false_count,
  count(*) FILTER (WHERE h.verdict) > count(*) FILTER (WHERE NOT h.verdict) AS verdict,
  count(*) > 1
    AND count(*) FILTER (WHERE h.verdict) > 0
    AND count(*) FILTER (WHERE NOT h.verdict) > 0 AS contested
FROM human_judgement h
GROUP BY h.sample_id, h.label;
