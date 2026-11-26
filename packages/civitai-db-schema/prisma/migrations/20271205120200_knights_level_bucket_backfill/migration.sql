-- One-time backfill of "KnightsQueueItem"."levelBucket" for the open rating items, after
-- 20271205120000_knights_level_bucket and before the Knights release that reads it. The Knights tick then keeps the
-- column filled (`syncLevelBuckets`, which also corrects drifted values), so the backfill only spares the first ticks after the
-- release from serving the backlog through the bounded NULL fallback.
--
-- Apply MANUALLY and REPEAT the statement until it reports UPDATE 0: each run sets at most 5000 rows, so no run holds
-- row locks on the queue long enough to stall votes. Rows another transaction holds are skipped and picked up by a later
-- run. Re-runnable at any time: only rows still NULL are selected. Each run scans the open items from the lowest id
-- upward past the rows earlier runs set, so later runs are slower, but each still finishes.
--
-- The CASE is `bucketLevelSql` (apps/knights/src/lib/server/queue/queue.service.ts) with the level flags spelled out;
-- change them together.
UPDATE "KnightsQueueItem" AS u
SET "levelBucket" = due.bucket
FROM (
  SELECT i.id,
    CASE
      WHEN jsonb_typeof(i.prediction -> 'value') = 'number'
        AND (i.prediction ->> 'value')::numeric IN (1, 2, 4, 8, 16)
        THEN (i.prediction ->> 'value')::numeric::int
      WHEN jsonb_typeof(i.prediction -> 'value') = 'string'
        AND (i.prediction ->> 'value') IN ('1', '2', '4', '8', '16')
        THEN (i.prediction ->> 'value')::int
      WHEN img."nsfwLevel" IN (1, 2, 4, 8, 16) THEN img."nsfwLevel"
      ELSE 0
    END AS bucket
  FROM "KnightsQueueItem" AS i
  INNER JOIN "Image" AS img ON img.id = i."imageId"
  WHERE i.status = 'Open'
    AND i.audience IS NULL
    AND NOT i."isHiddenCheck"
    AND i."levelBucket" IS NULL
  ORDER BY i.id
  LIMIT 5000
  FOR UPDATE OF i SKIP LOCKED
) AS due
WHERE u.id = due.id;
