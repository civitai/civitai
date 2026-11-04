-- One-off: models an earlier text scan marked NSFW and locked while their owner had them marked minor,
-- a real person or SFW-only. The scan no longer does this (it holds the verdict for a moderator); this
-- puts the models it already locked into the same Needs review lead. Nothing else changes: their nsfw
-- flag and system lock stay until a moderator rules (Keep lifts them).
--
-- HAND-APPLIED, after the release that ships the lead. Predicate only. Idempotent: a model already
-- carrying a lead is skipped. Excluded: any model a moderator ruled on its nsfw rating after the system
-- lock (the same activities rating-review.entities.ts treats as a moderator's lock). A malformed lock
-- time counts every such activity, so it skips rather than aborts the run.
--
-- 1. Dry run: the count to expect.
SELECT count(*) AS to_backfill
FROM "Model" m
WHERE m.nsfw
  AND 'nsfw' = ANY(m."lockedProperties")
  AND jsonb_typeof(m.meta) = 'object'
  AND m.meta ? 'systemNsfwLock'
  AND (m.minor OR m.poi OR m."sfwOnly")
  AND NOT m.meta ? 'restrictedNsfwVerdict'
  AND m."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "ModActivity" a
    WHERE a."entityType" = 'model' AND a."entityId" = m.id
      AND a."createdAt" > CASE
        WHEN m.meta->'systemNsfwLock'->>'at' ~ '^\d{4}-\d{2}-\d{2}T'
          THEN (m.meta->'systemNsfwLock'->>'at')::timestamptz
        ELSE '-infinity'::timestamptz END
      AND a.activity IN ('lockProperty:nsfw', 'unlockProperty:nsfw', 'setSfwOnly', 'unsetSfwOnly', 'setMinor', 'setMinorAutoHash',
          'setMinorTextScan', 'unsetMinor', 'rollbackMinorAutoHash', 'setPoi', 'setPoiAutoHash',
          'unsetPoi', 'revertPoiAutoHash')
  );

-- 2. The write, in a transaction: check the returned count matches step 1 before COMMIT.
BEGIN;
WITH stamped AS (
  UPDATE "Model" m
  SET meta = m.meta || jsonb_build_object(
    'restrictedNsfwVerdict', jsonb_build_object(
      'source', COALESCE(m.meta->'systemNsfwLock'->>'source', 'text-scan'),
      'at', m.meta->'systemNsfwLock'->>'at',
      'restriction', CASE WHEN m.minor THEN 'minor' WHEN m.poi THEN 'poi' ELSE 'sfwOnly' END
    )
  )
  WHERE m.nsfw
    AND 'nsfw' = ANY(m."lockedProperties")
    AND jsonb_typeof(m.meta) = 'object'
    AND m.meta ? 'systemNsfwLock'
    AND (m.minor OR m.poi OR m."sfwOnly")
    AND NOT m.meta ? 'restrictedNsfwVerdict'
    AND m."deletedAt" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "ModActivity" a
      WHERE a."entityType" = 'model' AND a."entityId" = m.id
        AND a."createdAt" > CASE
        WHEN m.meta->'systemNsfwLock'->>'at' ~ '^\d{4}-\d{2}-\d{2}T'
          THEN (m.meta->'systemNsfwLock'->>'at')::timestamptz
        ELSE '-infinity'::timestamptz END
        AND a.activity IN ('lockProperty:nsfw', 'unlockProperty:nsfw', 'setSfwOnly', 'unsetSfwOnly', 'setMinor', 'setMinorAutoHash',
            'setMinorTextScan', 'unsetMinor', 'rollbackMinorAutoHash', 'setPoi', 'setPoiAutoHash',
            'unsetPoi', 'revertPoiAutoHash')
    )
  RETURNING m.id
)
SELECT count(*) AS backfilled, array_agg(id ORDER BY id) AS ids FROM stamped;
-- COMMIT;  -- only when `backfilled` equals `to_backfill`; otherwise ROLLBACK. Keep the printed `ids`.
--
-- Rollback (before any moderator ruled), scoped to the printed ids so no lead written since is touched:
--   UPDATE "Model" SET meta = meta - 'restrictedNsfwVerdict' WHERE id = ANY('{<printed ids>}'::int[]);
