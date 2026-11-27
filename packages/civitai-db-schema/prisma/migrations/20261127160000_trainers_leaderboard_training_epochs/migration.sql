-- Trainers leaderboard: count every on-site training run, not only the legacy job type.
-- Data row, not schema. Apply by hand; this repo does not run prisma migrate deploy.
-- Do not apply between 23:00 and 00:01 UTC (prepare-leaderboard / deliver-leaderboard-cosmetics).
-- Standings change on the next prepare-leaderboard run.
--
-- The board matched only jobType 'ImageResourceTraining', which on-site training stopped writing:
-- runs are now 'AIToolkitTrainingEpoch' (and 'ComfyTrainingEpoch'). This adds both. Gate and AgeClassification jobs a training also dispatches are not epochs and stay out.
-- createdAt <= now() drops orchestration.jobs' corrupt far-future rows. The 30-day window,
-- entries = uniq(jobId), LIMIT 1100 and score = round(sqrt(spend)*1000) are unchanged.
--
-- Fails closed: the update runs only when the live query is byte for byte the reviewed text (md5
-- below), and the result must hash to the reviewed fixed text. Any other text RAISEs and changes
-- nothing; apply by hand after reading it. Idempotent: a re-run finds the fixed text and changes
-- nothing.

BEGIN;

DO $$
DECLARE
  live_md5 constant text := 'eadad1f85747b141da363493ea87774b';
  fixed_md5 constant text := '2c0c07ecdd674ffe2f454f5db4ee0d8e';
  crlf constant text := chr(13) || chr(10);
  q text;
BEGIN
  SELECT query INTO q FROM "Leaderboard" WHERE id = 'trainers' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'trainers leaderboard row not found - nothing to update';
  END IF;

  IF md5(q) = fixed_md5 THEN
    RAISE NOTICE 'trainers query already counts training epochs - no change';
    RETURN;
  END IF;

  IF md5(q) <> live_md5 THEN
    RAISE EXCEPTION 'trainers query (md5 %) differs from the reviewed text (md5 %) - inspect SELECT query FROM "Leaderboard" WHERE id=''trainers'' and apply by hand', md5(q), live_md5;
  END IF;

  q := replace(q,
    chr(9) || 'AND jobType IN (''ImageResourceTraining'')',
    chr(9) || 'AND createdAt <= now()' || crlf
      || chr(9) || 'AND jobType IN (''ImageResourceTraining'', ''AIToolkitTrainingEpoch'', ''ComfyTrainingEpoch'')');

  IF md5(q) <> fixed_md5 THEN
    RAISE EXCEPTION 'rewritten trainers query hashes to %, not the reviewed %', md5(q), fixed_md5;
  END IF;

  UPDATE "Leaderboard" SET query = q WHERE id = 'trainers';
END $$;

COMMIT;
