-- Writer leaderboard: gate articles on their rating, not the dead Article.nsfw flag.
-- Data row, not schema. Apply by hand; this repo does not run prisma migrate deploy.
-- Do not apply between 23:00 and 00:01 UTC (prepare-leaderboard / deliver-leaderboard-cosmetics).
-- Standings change on the next prepare-leaderboard run.
--
-- The writer query filtered on `not a.nsfw`, which nothing writes any more, so articles rated R and
-- above scored. It now uses the story-writer board's filters: rated PG or PG-13 only
-- (nsfwLevel inside sfwBrowsingLevelsFlag = 3; unrated excluded), scanned, not a ToS violation,
-- not unlisted, not Private, by an owner who is not banned. Scoring weights are unchanged.
--
-- Fails closed: the update runs only when the live query is byte for byte the text read from the
-- replica on 2026-11-14 (md5 below), and the result must hash to the reviewed fixed text. Any other
-- text RAISEs and changes nothing; apply by hand after reading it. Idempotent: a re-run finds the
-- fixed text and changes nothing.

BEGIN;

DO $$
DECLARE
  live_md5 constant text := '8154a62eb1356fb3716faaa8173dc1d6';
  fixed_md5 constant text := 'fad555977f62a2b5773ddf89379e544b';
  indent constant text := chr(13) || chr(10) || chr(9) || '  ';
  q text;
BEGIN
  SELECT query INTO q FROM "Leaderboard" WHERE id = 'writer';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'writer leaderboard row not found - nothing to update';
  END IF;

  IF md5(q) = fixed_md5 THEN
    RAISE NOTICE 'writer query already has the maturity gate - no change';
    RETURN;
  END IF;

  IF md5(q) <> live_md5 THEN
    RAISE EXCEPTION 'writer query (md5 %) differs from the reviewed text (md5 %) - it was edited since 2026-11-14; inspect SELECT query FROM "Leaderboard" WHERE id=''writer'' and apply by hand', md5(q), live_md5;
  END IF;

  q := replace(q,
    indent || 'AND u."deletedAt" IS NULL AND u.id > 0',
    indent || 'AND u."deletedAt" IS NULL AND u."bannedAt" IS NULL AND u.id > 0');
  q := replace(q,
    indent || 'AND not a.nsfw',
    indent || 'AND a.ingestion = ''Scanned'''
      || indent || 'AND NOT a."tosViolation"'
      || indent || 'AND NOT a.unlisted'
      || indent || 'AND a.availability <> ''Private'''
      || indent || 'AND a."nsfwLevel" <> 0 AND (a."nsfwLevel" & ~3) = 0');

  IF md5(q) <> fixed_md5 THEN
    RAISE EXCEPTION 'rewritten writer query hashes to %, not the reviewed %', md5(q), fixed_md5;
  END IF;

  UPDATE "Leaderboard" SET query = q WHERE id = 'writer';
END $$;

COMMIT;
