-- Read-only. Classifies the moderator-ruled items by the level their votes were graded against:
-- tier1: the answer of the votes graded correct (exactly one such answer).
-- tier2: every vote graded failed, the image is still under a lock other than Knights' own at a level (not 0 or
--   Blocked, no block marker) that no vote answered (a vote with that answer would have been graded correct, so a
--   match means the level moved since the ruling), and resolvedValue is an answer graded failed. A resolvedValue that
--   is neither a failed answer nor the image's level is an earlier moderator level: `left_already_moderator_level`.
-- `tierN_to_fix` is what apply.sql updates; `consistent` already holds its level; every `left_*` row is left as it is
-- (`left_contradicted`: of those, the ones whose resolvedValue is an answer graded failed). `sample`: up to 20 rows to fix.
-- shared CTE: identical in dry-run.sql and apply.sql (the backfill test checks)
WITH ruled AS (
  SELECT id, "imageId", "resolvedValue"
  FROM "KnightsQueueItem"
  WHERE status = 'Closed' AND reason = 'moderator-ruled' AND "questionKey" = 'knights.image.nsfwLevel'
),
votes AS (
  SELECT
    v."itemId",
    array_agg(DISTINCT v.answer) FILTER (WHERE v.verdict = 'correct') AS correct_answers,
    array_agg(DISTINCT v.answer) FILTER (WHERE v.verdict = 'failed') AS failed_answers,
    array_agg(DISTINCT v.answer) AS answers,
    bool_and(v.verdict = 'failed') AS all_failed
  FROM "KnightsVote" v
  WHERE v."itemId" IN (SELECT id FROM ruled)
  GROUP BY v."itemId"
),
classified AS (
  SELECT
    r.id,
    r."imageId",
    r."resolvedValue",
    v.correct_answers,
    v.failed_answers,
    img."nsfwLevel",
    CASE
      WHEN cardinality(v.correct_answers) = 1 THEN 'tier1'
      WHEN cardinality(v.correct_answers) > 1 THEN 'several_correct_answers'
      WHEN NOT v.all_failed THEN 'ungraded_votes'
      WHEN NOT COALESCE(
        img."nsfwLevelLocked"
          AND (img.metadata ->> 'nsfwLevelReason') IS DISTINCT FROM 'Knights Vote'
          AND img."nsfwLevel" NOT IN (0, 32)
          AND img.ingestion <> 'Blocked'
          AND img."blockedFor" IS NULL,
        false
      ) THEN 'image_not_ruled'
      WHEN img."nsfwLevel"::text = ANY (v.answers) THEN 'level_matches_a_vote'
      WHEN r."resolvedValue" = img."nsfwLevel"::text OR r."resolvedValue" = ANY (v.failed_answers) THEN 'tier2'
      ELSE 'already_moderator_level'
    END AS tier
  FROM ruled r
  JOIN votes v ON v."itemId" = r.id
  LEFT JOIN "Image" img ON img.id = r."imageId"
),
targeted AS (
  SELECT
    *,
    CASE tier WHEN 'tier1' THEN correct_answers[1] WHEN 'tier2' THEN "nsfwLevel"::text END AS truth
  FROM classified
)
-- end of shared CTE
SELECT
  count(*) FILTER (WHERE tier = 'tier1' AND truth IS DISTINCT FROM "resolvedValue") AS tier1_to_fix,
  count(*) FILTER (WHERE tier = 'tier2' AND truth IS DISTINCT FROM "resolvedValue") AS tier2_to_fix,
  count(*) FILTER (WHERE truth = "resolvedValue") AS consistent,
  count(*) FILTER (WHERE tier = 'several_correct_answers') AS left_several_correct_answers,
  count(*) FILTER (WHERE tier = 'ungraded_votes') AS left_ungraded_votes,
  count(*) FILTER (WHERE tier = 'image_not_ruled') AS left_image_not_ruled,
  count(*) FILTER (WHERE tier = 'level_matches_a_vote') AS left_level_matches_a_vote,
  count(*) FILTER (WHERE tier = 'already_moderator_level') AS left_already_moderator_level,
  count(*) FILTER (WHERE truth IS NULL AND "resolvedValue" = ANY (failed_answers)) AS left_contradicted,
  (
    SELECT COALESCE(json_agg(s ORDER BY s.id), '[]')
    FROM (
      SELECT id, "imageId", "resolvedValue", truth, tier
      FROM targeted
      WHERE truth IS DISTINCT FROM "resolvedValue" AND truth IS NOT NULL
      ORDER BY id
      LIMIT 20
    ) s
  ) AS sample
FROM targeted;
