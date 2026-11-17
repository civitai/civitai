-- Story Writers leaderboard: story articles rated R and above count, as they do on the Writers board
-- (20261114150000_writer_leaderboard_drop_rating_gate); unrated articles still do not. Only the
-- rating clause in the stored query changes; every other filter and weight stays.
-- Data row, not schema. Apply by hand; this repo does not run prisma migrate deploy. Apply AFTER the
-- category backfill has been run with includeMature (/api/admin/temp/article-category-backfill), or
-- the board scores only the R+ stories classified so far. Do not apply between 23:00 and 00:01 UTC
-- (prepare-leaderboard / deliver-leaderboard-cosmetics). Leaves "active" as it is.
--
-- Fails closed: the update runs only when the live query is byte for byte the text
-- 20271114120000_story_writer_system_category wrote (md5 below), and the result must hash to the
-- reviewed text. Any other text RAISEs and changes nothing. Idempotent: a re-run finds the reviewed
-- text and changes nothing.

BEGIN;

DO $$
DECLARE
  live_md5 constant text := '36a04202e0a7ed9eeeae5dcc980a308a';
  fixed_md5 constant text := '7e590d3b3b65d6c0a8d6f2f07d54d0b8';
  q text;
BEGIN
  SELECT query INTO q FROM "Leaderboard" WHERE id = 'story-writer' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'story-writer leaderboard row not found - nothing to update';
  END IF;

  IF md5(q) = fixed_md5 THEN
    RAISE NOTICE 'story-writer query already counts story articles of every rating - no change';
    RETURN;
  END IF;

  IF md5(q) <> live_md5 THEN
    RAISE EXCEPTION 'story-writer query (md5 %) is not the reviewed text (md5 %) - apply 20271114120000_story_writer_system_category first, or inspect SELECT query FROM "Leaderboard" WHERE id = ''story-writer'' and apply by hand', md5(q), live_md5;
  END IF;

  q := replace(q,
    chr(10) || '  AND a."nsfwLevel" <> 0 AND (a."nsfwLevel" & ~3) = 0' || chr(10),
    chr(10) || '  AND a."nsfwLevel" <> 0' || chr(10));

  IF md5(q) <> fixed_md5 THEN
    RAISE EXCEPTION 'rewritten story-writer query hashes to %, not the reviewed %', md5(q), fixed_md5;
  END IF;

  UPDATE "Leaderboard" SET query = q WHERE id = 'story-writer';
END $$;

COMMIT;
