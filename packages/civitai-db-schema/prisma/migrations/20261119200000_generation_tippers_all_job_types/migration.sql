-- Generation tippers ("Buzz Daddies") leaderboard: count tips on every orchestrator job type.
-- Data row, not schema. Apply by hand; this repo does not run prisma migrate deploy.
-- Do not apply between 23:00 and 00:01 UTC (prepare-leaderboard / deliver-leaderboard-cosmetics).
-- Standings, the board's badge cosmetics and its top-100 ranks change on the next
-- prepare-leaderboard run.
--
-- The board only counted tips on TextToImageV2, TextToImage and Comfy jobs, a list nobody kept up
-- as new job types shipped, so most generation tips did not count. This drops the job type filter:
-- every job with creatorsTip > 0 counts. Its per-user count is jobs, which now include video, so
-- the metric is renamed imageCount -> generationCount (shown as "Generations"). The 30-day window,
-- the 2024-08-01 floor, LIMIT 1000 and score = floor(tips) are unchanged.
--
-- Fails closed: the update runs only when the live query is byte for byte the reviewed text (md5
-- below), and the result must hash to the reviewed fixed text. Any other text RAISEs and changes
-- nothing; apply by hand after reading it. Idempotent: a re-run finds the fixed text and changes
-- nothing.

BEGIN;

DO $$
DECLARE
  live_md5 constant text := 'ba129c01d01f9275ff0ebc65d78dae33';
  fixed_md5 constant text := '77c52311ca8bbb3204cd4b8dcaaffbc2';
  crlf constant text := chr(13) || chr(10);
  q text;
BEGIN
  SELECT query INTO q FROM "Leaderboard" WHERE id = 'generationTippers' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'generationTippers leaderboard row not found - nothing to update';
  END IF;

  IF md5(q) = fixed_md5 THEN
    RAISE NOTICE 'generationTippers query already counts every job type - no change';
    RETURN;
  END IF;

  IF md5(q) <> live_md5 THEN
    RAISE EXCEPTION 'generationTippers query (md5 %) differs from the reviewed text (md5 %) - inspect SELECT query FROM "Leaderboard" WHERE id=''generationTippers'' and apply by hand', md5(q), live_md5;
  END IF;

  q := replace(q,
    chr(9) || 'WHERE jobType IN (''TextToImageV2'', ''TextToImage'', ''Comfy'')' || crlf
      || chr(9) || chr(9) || 'AND creatorsTip > 0',
    chr(9) || 'WHERE creatorsTip > 0');
  q := replace(q, 'map(''imageCount'', ', 'map(''generationCount'', ');

  IF md5(q) <> fixed_md5 THEN
    RAISE EXCEPTION 'rewritten generationTippers query hashes to %, not the reviewed %', md5(q), fixed_md5;
  END IF;

  UPDATE "Leaderboard" SET query = q WHERE id = 'generationTippers';
END $$;

COMMIT;
