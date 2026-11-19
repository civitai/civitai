-- Read-only. Classifies every rating item waiting on the Inquisitors as `no-consensus` by what Knights now does with a rating
-- that reaches no consensus at the end of the path (`rerate` and `escalateExpired` in queue.service.ts):
-- to_rerate: Resolved at the most-voted level of its last stage (counted votes, weight > 0; a tie goes to the highest level),
--   votes set aside as inconclusive, unwritten, so the tick's write-back writes it as any settled rating.
-- to_blocked: the pick is Blocked, at any vote count, so it stays with the Inquisitors as `blocked`.
-- to_expired: its last stage has fewer counted votes than the stage's quorum (and the pick is not Blocked): Closed `expired`,
--   votes inconclusive.
-- The last stage is the highest stage with a counted vote (the item's own stage reads Inquisitor). `sample`: up to 20 rows.
-- shared CTE: identical in dry-run.sql and apply.sql (keep them in step)
WITH waiting AS (
  SELECT id, "imageId"
  FROM "KnightsQueueItem"
  WHERE status = 'Inquisitor' AND "escalationReason" = 'no-consensus' AND "questionKey" = 'knights.image.nsfwLevel'
),
counted AS (
  SELECT v."itemId", v.stage, v.answer, v."playerId", v."createdAt"
  FROM "KnightsVote" v
  WHERE v."itemId" IN (SELECT id FROM waiting) AND v.weight > 0
),
last_stage AS (
  SELECT
    "itemId",
    (array_agg(stage ORDER BY CASE stage WHEN 'Paladin' THEN 3 WHEN 'Templar' THEN 2 WHEN 'Knight' THEN 1 ELSE 0 END DESC))[1]
      AS stage
  FROM counted
  GROUP BY "itemId"
),
at_stage AS (
  SELECT c.*
  FROM counted c
  JOIN last_stage l ON l."itemId" = c."itemId" AND l.stage = c.stage
),
picked AS (
  SELECT DISTINCT ON ("itemId") "itemId", answer AS pick, sum(n) OVER (PARTITION BY "itemId") AS stage_votes
  FROM (SELECT "itemId", answer, count(*) AS n FROM at_stage GROUP BY "itemId", answer) t
  ORDER BY "itemId", n DESC, CASE WHEN answer ~ '^[0-9]+$' THEN answer::int END DESC NULLS LAST
),
actor AS (
  SELECT DISTINCT ON (s."itemId") s."itemId", s."playerId"
  FROM at_stage s
  JOIN picked p ON p."itemId" = s."itemId" AND p.pick = s.answer
  ORDER BY s."itemId", s."createdAt" DESC, s."playerId" DESC
),
targeted AS (
  SELECT
    w.id,
    w."imageId",
    l.stage,
    p.pick,
    p.stage_votes::int AS stage_votes,
    a."playerId" AS actor,
    img."nsfwLevel" AS from_level,
    CASE
      WHEN l.stage IS NULL THEN 'expired'
      -- Blocked goes to the Inquisitors whatever the count.
      WHEN p.pick = '32' THEN 'blocked'
      -- votesNeededAt (stage-rules.ts): change with STAGE_RULES.
      WHEN p.stage_votes < CASE l.stage WHEN 'Knight' THEN 4 WHEN 'Templar' THEN 3 WHEN 'Paladin' THEN 2 END
        THEN 'expired'
      ELSE 'rerate'
    END AS outcome
  FROM waiting w
  LEFT JOIN last_stage l ON l."itemId" = w.id
  LEFT JOIN picked p ON p."itemId" = w.id
  LEFT JOIN actor a ON a."itemId" = w.id
  LEFT JOIN "Image" img ON img.id = w."imageId"
)
-- end of shared CTE
SELECT
  count(*) FILTER (WHERE outcome = 'rerate') AS to_rerate,
  count(*) FILTER (WHERE outcome = 'blocked') AS to_blocked,
  count(*) FILTER (WHERE outcome = 'expired') AS to_expired,
  (
    SELECT COALESCE(json_agg(s ORDER BY s.id), '[]')
    FROM (
      SELECT id, "imageId", stage, pick, stage_votes, from_level, outcome
      FROM targeted
      ORDER BY id
      LIMIT 20
    ) s
  ) AS sample
FROM targeted;
