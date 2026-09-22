-- The browsing level is one column on every domain. Fold any level still held in
-- settings.redBrowsingLevel into the column, then drop the key.
--   - Where the two share a bit, the new level is their intersection: a narrowing made on red is
--     kept and nothing the column excluded is switched on.
--   - A red level of 0 (every level deselected) counts as PG, which is what the client showed.
--   - Where the two share NO bit, the red level wins. This is the only branch that can switch on a
--     level the column excluded; confirm it matches no rows before applying.
--   - A value that is not a non-negative whole number is left in place, untouched.
-- Data only; apply by hand AFTER the code that stops writing the key has deployed.
UPDATE "User" u
SET
  "browsingLevel" = CASE
    WHEN (u."browsingLevel" & r.level) <> 0 THEN u."browsingLevel" & r.level
    ELSE r.level
  END,
  settings = u.settings - 'redBrowsingLevel'
FROM (
  SELECT
    id,
    CASE
      WHEN (settings->>'redBrowsingLevel')::int > 0 THEN (settings->>'redBrowsingLevel')::int
      ELSE 1
    END AS level
  FROM "User"
  WHERE settings ? 'redBrowsingLevel'
    AND jsonb_typeof(settings->'redBrowsingLevel') = 'number'
    AND (settings->>'redBrowsingLevel') ~ '^[0-9]+$'
) r
WHERE u.id = r.id;
