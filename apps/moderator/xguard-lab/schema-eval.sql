-- Evaluation runs: score a label's policy against the ground truth humans have confirmed.
--
-- Additive to schema.sql. Apply with:
--   docker exec -i xguard-lab-db psql -U xguard -d xguard_lab < schema-eval.sql

CREATE TABLE IF NOT EXISTS eval_run (
  id            bigserial PRIMARY KEY,
  label         text NOT NULL,
  -- Which policy was under test. Null means "whatever the live registry had", which is the
  -- baseline every candidate gets compared against.
  policy_id     bigint REFERENCES label_policy(id),
  policy_label  text NOT NULL,
  threshold     real NOT NULL,
  -- Restrict to one sampling batch, or null for every sample with ground truth.
  batch         text,
  status        text NOT NULL DEFAULT 'running',
  total         int NOT NULL DEFAULT 0,
  scored        int NOT NULL DEFAULT 0,
  errors        int NOT NULL DEFAULT 0,
  tp            int NOT NULL DEFAULT 0,
  fp            int NOT NULL DEFAULT 0,
  tn            int NOT NULL DEFAULT 0,
  fn            int NOT NULL DEFAULT 0,
  precision     real,
  recall        real,
  f1            real,
  note          text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

CREATE INDEX IF NOT EXISTS eval_run_label_idx ON eval_run (label, started_at DESC);

-- Per-sample outcome, so a run can be drilled into rather than just reporting four numbers.
-- This is what makes "show me what it got wrong" possible.
CREATE TABLE IF NOT EXISTS eval_result (
  id            bigserial PRIMARY KEY,
  run_id        bigint NOT NULL REFERENCES eval_run(id) ON DELETE CASCADE,
  sample_id     bigint NOT NULL REFERENCES sample(id) ON DELETE CASCADE,
  score         real,
  predicted     boolean,
  expected      boolean NOT NULL,
  bucket        text,
  reason        text,
  error         text,
  UNIQUE (run_id, sample_id)
);

CREATE INDEX IF NOT EXISTS eval_result_run_bucket_idx ON eval_result (run_id, bucket);
