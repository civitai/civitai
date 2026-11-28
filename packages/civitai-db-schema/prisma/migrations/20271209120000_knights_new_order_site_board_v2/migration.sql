-- Knights of New Order site leaderboard (/leaderboard/knights-new-order): score the Knights app's votes.
-- Data row, not schema. Apply by hand; this repo does not run prisma migrate deploy.
-- Do not apply between 23:00 and 00:01 UTC (prepare-leaderboard / deliver-leaderboard-cosmetics).
-- Standings change on the next prepare-leaderboard run.
--
-- The row still held the original in-app game's query: ClickHouse knights_new_order_image_rating over 7 days,
-- fervor = correct * 100 * max(accuracy, 0.1). That game no longer takes votes, so the only rows left in its window
-- are its last pending votes being settled, one each. The Knights app scores from "KnightsVote" with accuracy
-- squared (apps/knights/src/lib/server/progression/fervor.ts); this makes the site board compute the same thing as
-- the app's own board (apps/knights/src/lib/server/leaderboard.ts queryBoard): Knight rank and above, settled
-- correct or failed votes cast in the last 7 days and after the player's startAt, fervor above 0. The job itself
-- drops banned, deleted and excluded accounts. Accuracy below 10% counts as 10%, which makes fervor = correct.
-- c^3 * 100 / g^2 is integer division, so it floors exactly as the app does.
--
-- Fails closed: it replaces the query only when the live one still reads the original game's table, and RAISEs,
-- changing nothing, on any other text. Idempotent: a re-run finds the new text and changes nothing.

BEGIN;

DO $$
DECLARE
  new_query constant text := $q$SELECT
  t."userId",
  CASE
    WHEN t.correct * 10 < t.graded THEN t.correct
    ELSE (t.correct * t.correct * t.correct * 100) / (t.graded * t.graded)
  END AS score,
  jsonb_build_object('correctJudgments', t.correct, 'allJudgments', t.graded) AS metrics
FROM (
  SELECT
    v."playerId" AS "userId",
    count(*) AS graded,
    count(*) FILTER (WHERE v.verdict = 'correct') AS correct
  FROM "KnightsVote" v
  JOIN "NewOrderPlayer" p ON p."userId" = v."playerId"
  WHERE v."createdAt" >= (now() AT TIME ZONE 'UTC') - interval '7 days'
    AND v."settledAt" IS NOT NULL
    AND v.verdict IN ('correct', 'failed')
    AND v."createdAt" >= p."startAt"
    AND p."rankType" IN ('Knight', 'Templar', 'Paladin')
  GROUP BY v."playerId"
) t
WHERE t.correct > 0$q$;
  new_description constant text := 'Fervor = correct judgments × 100 × accuracy × accuracy' || chr(10)
    || 'Accuracy = correct judgments ÷ all graded judgments. Below 10% it counts as 10%.' || chr(10)
    || 'Counts the judgments of Knights, Templars and Paladins once they are settled.' || chr(10)
    || '---' || chr(10)
    || 'Last 7 days';
  q text;
BEGIN
  SELECT query INTO q FROM "Leaderboard" WHERE id = 'knights-new-order' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'knights-new-order leaderboard row not found - nothing to update';
  END IF;

  IF q = new_query THEN
    RAISE NOTICE 'knights-new-order already scores Knights app votes - no change';
    RETURN;
  END IF;

  IF position('knights_new_order_image_rating' IN q) = 0 THEN
    RAISE EXCEPTION 'knights-new-order query does not read knights_new_order_image_rating (md5 %) - inspect SELECT query FROM "Leaderboard" WHERE id=''knights-new-order'' and apply by hand', md5(q);
  END IF;

  UPDATE "Leaderboard"
  SET query = new_query, "scoringDescription" = new_description
  WHERE id = 'knights-new-order';
END $$;

COMMIT;
