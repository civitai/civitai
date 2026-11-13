-- Idempotent: applied by hand, possibly more than once.
--
-- "Sold N Buzz from your shop." read as selling Buzz itself; the badge is for Buzz earned from
-- shop sales. Each row is matched by key and its old text, so a re-run, or a row edited since,
-- is left alone. A run that changes some but not all of the five rows aborts.
DO $$
DECLARE
  changed int;
BEGIN
  UPDATE "CreatorMilestone" AS m
  SET description = 'Earned ' || v.amount || ' Buzz from shop sales.'
  FROM (VALUES
    ('earn:shop-sales-100000',  '100,000'),
    ('earn:shop-sales-250000',  '250,000'),
    ('earn:shop-sales-500000',  '500,000'),
    ('earn:shop-sales-1000000', '1,000,000'),
    ('earn:shop-sales-2000000', '2,000,000')
  ) AS v(key, amount)
  WHERE m.key = v.key
    AND m.description = 'Sold ' || v.amount || ' Buzz from your shop.';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed NOT IN (0, 5) THEN
    RAISE EXCEPTION 'shop-sales copy: expected 0 or 5 rows, changed %', changed;
  END IF;
END $$;
