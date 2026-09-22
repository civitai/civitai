-- The browsing level is one column on every domain. Fold any level still held in
-- settings.redBrowsingLevel into it without widening either stored choice, then drop the key.
-- Where the two share no bit, the red choice is kept; an empty red level is just dropped. Data only; apply by hand.
UPDATE "User"
SET
  "browsingLevel" = CASE
    WHEN ("browsingLevel" & (settings->>'redBrowsingLevel')::int) <> 0
      THEN "browsingLevel" & (settings->>'redBrowsingLevel')::int
    WHEN (settings->>'redBrowsingLevel')::int > 0
      THEN (settings->>'redBrowsingLevel')::int
    ELSE "browsingLevel"
  END,
  settings = settings - 'redBrowsingLevel'
WHERE settings ? 'redBrowsingLevel'
  AND jsonb_typeof(settings->'redBrowsingLevel') = 'number';
