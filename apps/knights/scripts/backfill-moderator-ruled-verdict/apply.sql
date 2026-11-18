-- Sets resolvedValue on moderator-ruled items to the level their votes were graded against (the answer of a vote
-- graded correct). Items with no correct vote, or more than one correct answer, are left alone. Safe to run again:
-- a second run updates 0 rows. Run dry-run.sql first; this leaves the transaction open: COMMIT when the UPDATE's
-- row count equals the dry run's `to_fix`, otherwise ROLLBACK.
BEGIN;

UPDATE "KnightsQueueItem" i
SET "resolvedValue" = t.truth, "updatedAt" = now() AT TIME ZONE 'utc'
FROM (
  SELECT v."itemId", min(v.answer) AS truth
  FROM "KnightsVote" v
  WHERE v.verdict = 'correct'
    AND v."itemId" IN (
      SELECT id FROM "KnightsQueueItem"
      WHERE status = 'Closed' AND reason = 'moderator-ruled' AND "questionKey" = 'knights.image.nsfwLevel'
    )
  GROUP BY v."itemId"
  HAVING count(DISTINCT v.answer) = 1
) t
WHERE i.id = t."itemId"
  AND i.status = 'Closed'
  AND i.reason = 'moderator-ruled'
  AND i."questionKey" = 'knights.image.nsfwLevel'
  AND i."resolvedValue" IS DISTINCT FROM t.truth;
