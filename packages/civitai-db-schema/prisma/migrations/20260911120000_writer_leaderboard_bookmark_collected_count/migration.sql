-- Writer leaderboard bookmark term: read collectedCount, not the dead favoriteCount (ClickUp 868m3dd87).
-- Data row, not schema. Apply by hand; this repo does not run prisma migrate deploy.
--
-- The writer board scored its bookmark term off ArticleMetric."favoriteCount", the legacy
-- "Favorite" engagement count that has been frozen since favorites were deprecated and is no
-- longer written. Real article bookmarks are collects, tracked into ArticleMetric."collectedCount"
-- (article.metrics.ts writes collectedCount and never favoriteCount; ArticleSort.MostBookmarks
-- already sorts by collectedCount). So every recent bookmark scored as 0, and bookmarks are the
-- heaviest term in the formula (sqrt(bookmarks) * 10).
--
-- Surgical REPLACE rather than a full overwrite: it swaps only the two am."favoriteCount"
-- occurrences (the score expression and the 'bookmark' metrics jsonb) and leaves any later admin
-- edits to the query intact. Idempotent — a re-run finds no favoriteCount and the post-check passes.
-- scoringDescription ("sqrt(bookmarks) * 10") is unchanged; the term's meaning is the same, only the
-- source column.
--
-- The DO block makes a mismatch LOUD instead of a silent success. The brief guarantees favoriteCount
-- appears in the writer query only in the two bookmark terms being swapped, so the postcondition is
-- simply "no favoriteCount remains". The post-check asserts exactly that, which catches all three
-- failure shapes: a total no-op (live token is not am."favoriteCount" verbatim, so REPLACE matched
-- nothing and a bare UPDATE would report success while the board keeps scoring 0 — the exact symptom
-- being fixed); a PARTIAL swap (an admin edit since 2026-09-04 requoted just one occurrence, leaving
-- the score expr and the 'bookmark' jsonb reading different columns); and a re-run stays clean
-- (nothing left to match, nothing to raise). If a future edit introduces an unrelated favoriteCount
-- reference, this aborts too — a safe, legible failure the operator resolves by hand, unlike a silent
-- half-fix.
--
-- No backfill needed: collectedCount already holds the historical totals. Tallies repopulate on the
-- next prepare-leaderboard run.
--
-- Do not apply between 23:00 and 00:01 UTC (see prepare-leaderboard / isLeaderboardPopulated timing).

DO $$
DECLARE
  before_q text;
  after_q text;
BEGIN
  SELECT query INTO before_q FROM "Leaderboard" WHERE id = 'writer';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'writer leaderboard row not found — nothing to update';
  END IF;

  UPDATE "Leaderboard"
  SET query = REPLACE(query, 'am."favoriteCount"', 'am."collectedCount"')
  WHERE id = 'writer';

  SELECT query INTO after_q FROM "Leaderboard" WHERE id = 'writer';
  IF after_q LIKE '%favoriteCount%' THEN
    RAISE EXCEPTION 'writer query still references favoriteCount after the swap — a total no-op (live token is not am."favoriteCount" verbatim) or a partial swap (an admin edit requoted one of the two occurrences); inspect SELECT query FROM "Leaderboard" WHERE id=''writer'' and apply the fix by hand';
  END IF;
END $$;
