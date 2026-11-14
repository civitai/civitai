-- Writer leaderboard: articles rated R and above count again; unrated articles still do not.
-- Data row, not schema. Apply by hand; this repo does not run prisma migrate deploy.
-- Do not apply between 23:00 and 00:01 UTC (prepare-leaderboard / deliver-leaderboard-cosmetics).
-- Standings change on the next prepare-leaderboard run.
--
-- 20261114120000_writer_leaderboard_maturity_gate limited the writer board to articles rated PG or
-- PG-13. That rating cap was not intended. This removes the cap and keeps everything else that
-- migration added: rated (nsfwLevel <> 0), scanned, not a ToS violation, not unlisted, not Private,
-- by an owner who is not banned. Scoring weights are unchanged.
--
-- Fails closed: the update runs only when the live query is byte for byte the text the maturity
-- gate migration wrote (md5 below), and the result must hash to the reviewed fixed text. Any other
-- text RAISEs and changes nothing; apply by hand after reading it. Idempotent: a re-run finds the
-- fixed text and changes nothing.

BEGIN;

DO $$
DECLARE
  live_md5 constant text := 'fad555977f62a2b5773ddf89379e544b';
  fixed_md5 constant text := '5fa44000040991df80fa27b2aca6171f';
  indent constant text := chr(13) || chr(10) || chr(9) || '  ';
  q text;
BEGIN
  SELECT query INTO q FROM "Leaderboard" WHERE id = 'writer' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'writer leaderboard row not found - nothing to update';
  END IF;

  IF md5(q) = fixed_md5 THEN
    RAISE NOTICE 'writer query already counts articles of every rating - no change';
    RETURN;
  END IF;

  IF md5(q) <> live_md5 THEN
    RAISE EXCEPTION 'writer query (md5 %) differs from the reviewed text (md5 %) - apply 20261114120000_writer_leaderboard_maturity_gate first, or inspect SELECT query FROM "Leaderboard" WHERE id=''writer'' and apply by hand', md5(q), live_md5;
  END IF;

  q := replace(q,
    indent || 'AND a."nsfwLevel" <> 0 AND (a."nsfwLevel" & ~3) = 0',
    indent || 'AND a."nsfwLevel" <> 0');

  IF md5(q) <> fixed_md5 THEN
    RAISE EXCEPTION 'rewritten writer query hashes to %, not the reviewed %', md5(q), fixed_md5;
  END IF;

  UPDATE "Leaderboard" SET query = q WHERE id = 'writer';
END $$;

COMMIT;
