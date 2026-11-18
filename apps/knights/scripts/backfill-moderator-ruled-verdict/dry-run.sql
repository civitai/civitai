-- Read-only. Counts the moderator-ruled items whose resolvedValue is not the level their votes were graded against.
-- The answer of a vote graded correct is that level. `to_fix` is what apply.sql updates; `no_correct_vote` and
-- `several_correct_answers` give no single level and are left as they are (`no_correct_vote_contradicted`: of those,
-- the ones whose resolvedValue is an answer graded failed). The second statement samples the rows to fix.
WITH graded AS (
  SELECT
    i.id,
    i."resolvedValue",
    array_agg(DISTINCT v.answer) FILTER (WHERE v.verdict = 'correct') AS correct_answers,
    bool_or(v.verdict = 'failed' AND v.answer = i."resolvedValue") AS resolved_value_failed
  FROM "KnightsQueueItem" i
  JOIN "KnightsVote" v ON v."itemId" = i.id
  WHERE i.status = 'Closed'
    AND i.reason = 'moderator-ruled'
    AND i."questionKey" = 'knights.image.nsfwLevel'
  GROUP BY i.id, i."resolvedValue"
)
SELECT
  count(*) FILTER (
    WHERE cardinality(correct_answers) = 1 AND correct_answers[1] IS DISTINCT FROM "resolvedValue"
  ) AS to_fix,
  count(*) FILTER (WHERE cardinality(correct_answers) = 1 AND correct_answers[1] = "resolvedValue") AS consistent,
  count(*) FILTER (WHERE correct_answers IS NULL) AS no_correct_vote,
  count(*) FILTER (WHERE correct_answers IS NULL AND resolved_value_failed) AS no_correct_vote_contradicted,
  count(*) FILTER (WHERE cardinality(correct_answers) > 1) AS several_correct_answers
FROM graded;

SELECT i.id, i."imageId", i."resolvedValue", t.truth, i."updatedAt"
FROM "KnightsQueueItem" i
JOIN (
  SELECT v."itemId", min(v.answer) AS truth
  FROM "KnightsVote" v
  WHERE v.verdict = 'correct'
    AND v."itemId" IN (
      SELECT id FROM "KnightsQueueItem"
      WHERE status = 'Closed' AND reason = 'moderator-ruled' AND "questionKey" = 'knights.image.nsfwLevel'
    )
  GROUP BY v."itemId"
  HAVING count(DISTINCT v.answer) = 1
) t ON t."itemId" = i.id
WHERE i."resolvedValue" IS DISTINCT FROM t.truth
ORDER BY i.id
LIMIT 20;
