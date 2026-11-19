-- Settles every rating item waiting on the Inquisitors as `no-consensus` the way Knights now settles one, by the outcomes
-- dry-run.sql describes (the same shared CTE). Items no longer `Inquisitor` (a moderator is ruling on one) are left alone.
-- Safe to run again: a second run changes 0 rows. Apply after the re-rate change is deployed, so no new `no-consensus` item arrives.
-- Run dry-run.sql first, then this from an interactive psql session (`\i apply.sql`); `psql -f` rolls back at exit. It leaves
-- the transaction open and returns one row per outcome: COMMIT when each count equals the dry run's, otherwise ROLLBACK. Then
-- re-run dry-run.sql: expect 0 everywhere. `POST /api/jobs/tick` writes the re-rated levels back over the next ticks
-- (`applyPendingResolutions`: at most 100 per tick, within its 45 s budget).
-- Until COMMIT or ROLLBACK the transaction holds every row it changed, so a moderator ruling one of these items waits on it:
-- decide promptly. `lock_timeout` makes the apply fail fast instead of waiting on a row a moderator is ruling.
BEGIN;
SET LOCAL lock_timeout = '10s';

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
, settled AS (
  UPDATE "KnightsQueueItem" i
  SET
    status = CASE t.outcome WHEN 'rerate' THEN 'Resolved' WHEN 'expired' THEN 'Closed' ELSE i.status END,
    "minRank" = CASE WHEN t.outcome = 'blocked' THEN i."minRank" ELSE COALESCE(t.stage, i."minRank") END,
    "escalationReason" = CASE WHEN t.outcome = 'blocked' THEN 'blocked' END,
    reason = CASE t.outcome WHEN 'rerate' THEN 'no-consensus-rerate' WHEN 'expired' THEN 'expired' ELSE i.reason END,
    "resolvedValue" = CASE WHEN t.outcome = 'rerate' THEN t.pick ELSE i."resolvedValue" END,
    "resolvedAt" = CASE WHEN t.outcome = 'rerate' THEN now() AT TIME ZONE 'utc' ELSE i."resolvedAt" END,
    "resolvedBy" = CASE WHEN t.outcome = 'rerate' THEN t.actor ELSE i."resolvedBy" END,
    "resolvedFromLevel" = CASE WHEN t.outcome = 'rerate' THEN t.from_level ELSE i."resolvedFromLevel" END,
    "appliedAt" = CASE WHEN t.outcome = 'rerate' THEN NULL ELSE i."appliedAt" END,
    "nextAttemptAt" = CASE WHEN t.outcome = 'rerate' THEN NULL ELSE i."nextAttemptAt" END,
    "updatedAt" = now() AT TIME ZONE 'utc'
  FROM targeted t
  WHERE i.id = t.id AND i.status = 'Inquisitor' AND i."escalationReason" = 'no-consensus'
  RETURNING i.id, t.outcome
),
set_aside AS (
  UPDATE "KnightsVote" v
  SET verdict = 'inconclusive'
  FROM settled s
  WHERE v."itemId" = s.id AND s.outcome <> 'blocked' AND v.verdict = 'pending'
  RETURNING v."itemId"
)
SELECT s.outcome, count(*)::int AS items, COALESCE(sum(a.n), 0)::int AS votes_set_aside
FROM settled s
LEFT JOIN (SELECT "itemId", count(*) AS n FROM set_aside GROUP BY "itemId") a ON a."itemId" = s.id
GROUP BY s.outcome
ORDER BY s.outcome;
