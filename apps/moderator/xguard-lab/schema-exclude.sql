-- Let a judgement be retired without deleting it.
--
-- The first 37 rows were produced while a stale-DOM-read bug submitted the previous click's
-- answer, so the sequence is shifted by one and the verdicts cannot be trusted. Deleting them
-- would also delete the evidence that the bug was real (the duration_ms pattern: 8 nulls and a
-- 1ms minimum), and "just remember not to use those" is not a mechanism - the ground-truth query
-- would pick them straight back up.
--
-- NULL means valid. Anything non-null is a reason the row is retired, which reads better in a
-- query than a bare boolean and forces whoever excludes a row to say why.

ALTER TABLE human_judgement
  ADD COLUMN IF NOT EXISTS excluded_reason text;

CREATE INDEX IF NOT EXISTS human_judgement_valid_idx
  ON human_judgement (label, sample_id) WHERE excluded_reason IS NULL;

UPDATE human_judgement
   SET excluded_reason = 'stale-submit bug: recorded the previous click''s answer'
 WHERE excluded_reason IS NULL
   AND created_at < timestamptz '2026-08-05 00:00:00+00';
