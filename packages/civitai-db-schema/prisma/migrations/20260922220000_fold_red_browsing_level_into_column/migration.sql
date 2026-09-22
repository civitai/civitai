-- The browsing level is one column on every domain. Fold any level still held in
-- settings.redBrowsingLevel into the column, then drop the key.
--   - The new level is the intersection of the column and the red level, so a narrowing made on
--     red is kept and nothing the column excluded is switched on.
--   - A red level of 0 (every level deselected) counts as PG, which is what the client showed.
--   - If the two share no bit, the red level wins.
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
) r
WHERE u.id = r.id;
