-- The browsing level is one column on every domain. Fold any level still held in
-- settings.redBrowsingLevel into the column, then drop the key.
--   - Where the two share a bit, the new level is their intersection: a narrowing made on red is
--     kept and nothing the column excluded is switched on.
--   - A red level of 0 (every level deselected) counts as PG, which is what the client showed.
--   - Where the two share NO bit, the red level wins. This is the only branch that can switch on a
--     level the column excluded; confirm it matches no rows before applying.
--   - A value that is not a non-negative whole number is left in place, untouched.
-- Data only; apply by hand AFTER the code that stops writing the key has deployed.
--
-- Dry run first (read-only). `disjoint` must be 0 and `widened` must be 0:
--   SELECT count(*) AS rows,
--          count(*) FILTER (WHERE (col & red) <> 0 AND (col & red) <> col
--                              OR (col & red) = 0 AND red <> col) AS level_changes,
--          count(*) FILTER (WHERE (col & red) = 0) AS disjoint,
--          count(*) FILTER (WHERE (col & red) = 0 AND (red & ~col) <> 0) AS widened
--   FROM (
--     SELECT "browsingLevel" AS col,
--       CASE WHEN (settings->>'redBrowsingLevel')::int > 0
--         THEN (settings->>'redBrowsingLevel')::int ELSE 1 END AS red
--     FROM "User"
--     WHERE settings ? 'redBrowsingLevel'
--       AND jsonb_typeof(settings->'redBrowsingLevel') = 'number'
--       AND (settings->>'redBrowsingLevel') ~ '^[0-9]{1,9}$'
--   ) t;
-- Single-table on purpose: every value is read from the row being updated, so a user who changes
-- their level while this runs (which removes the key) is re-checked against that new row and
-- skipped, instead of being overwritten from a stale snapshot.
UPDATE "User"
SET
  "browsingLevel" = CASE
    WHEN ("browsingLevel" & GREATEST((settings->>'redBrowsingLevel')::int, 1)) <> 0
      THEN "browsingLevel" & GREATEST((settings->>'redBrowsingLevel')::int, 1)
    ELSE GREATEST((settings->>'redBrowsingLevel')::int, 1)
  END,
  settings = settings - 'redBrowsingLevel'
WHERE settings ? 'redBrowsingLevel'
  AND jsonb_typeof(settings->'redBrowsingLevel') = 'number'
  AND (settings->>'redBrowsingLevel') ~ '^[0-9]{1,9}$';
