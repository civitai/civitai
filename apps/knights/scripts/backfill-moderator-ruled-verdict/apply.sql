-- Sets resolvedValue on moderator-ruled items to the level their votes were graded against, by the tiers dry-run.sql
-- describes (keep the two CTEs identical). Every other row is left alone. Safe to run again: a second run updates 0 rows.
-- Run dry-run.sql first; this leaves the transaction open: COMMIT when the UPDATE's row count equals the dry run's
-- `tier1_to_fix` + `tier2_to_fix`, otherwise ROLLBACK.
BEGIN;

WITH ruled AS (
  SELECT id, "imageId", "resolvedValue"
  FROM "KnightsQueueItem"
  WHERE status = 'Closed' AND reason = 'moderator-ruled' AND "questionKey" = 'knights.image.nsfwLevel'
),
votes AS (
  SELECT
    v."itemId",
    array_agg(DISTINCT v.answer) FILTER (WHERE v.verdict = 'correct') AS correct_answers,
    array_agg(DISTINCT v.answer) AS answers,
    bool_and(v.verdict = 'failed') AS all_failed
  FROM "KnightsVote" v
  WHERE v."itemId" IN (SELECT id FROM ruled)
  GROUP BY v."itemId"
),
classified AS (
  SELECT
    r.id,
    r."resolvedValue",
    v.correct_answers,
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
      ELSE 'tier2'
    END AS tier
  FROM ruled r
  JOIN votes v ON v."itemId" = r.id
  LEFT JOIN "Image" img ON img.id = r."imageId"
),
targeted AS (
  SELECT
    id,
    "resolvedValue",
    CASE tier WHEN 'tier1' THEN correct_answers[1] WHEN 'tier2' THEN "nsfwLevel"::text END AS truth
  FROM classified
)
UPDATE "KnightsQueueItem" i
SET "resolvedValue" = t.truth, "updatedAt" = now() AT TIME ZONE 'utc'
FROM targeted t
WHERE i.id = t.id
  AND t.truth IS NOT NULL
  AND i.status = 'Closed'
  AND i.reason = 'moderator-ruled'
  AND i."resolvedValue" IS DISTINCT FROM t.truth;
