-- Drops "HeldAnswer", which nothing reads or writes any more. Hand-applied.
--
-- One statement: the lock stops a write landing between the count and the drop, and a table with
-- any row raises instead of being dropped.
DO $$
DECLARE
  n bigint;
BEGIN
  LOCK TABLE "HeldAnswer" IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO n FROM "HeldAnswer";
  IF n > 0 THEN
    RAISE EXCEPTION 'HeldAnswer has % rows; not dropped', n;
  END IF;
  DROP TABLE "HeldAnswer";
END $$;
