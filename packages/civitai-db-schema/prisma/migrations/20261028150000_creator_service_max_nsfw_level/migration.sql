-- Idempotent: applied by hand, possibly more than once.
--
-- The highest content rating a Creator Services offering delivers, copied onto each deal at request
-- time like its price. One NsfwLevel value (PG 1, PG-13 2, R 4, X 8, XXX 16), never a mask and never
-- Blocked. The default, PG-13, is what every service is limited to today, so existing rows keep their
-- behaviour. Apply BEFORE deploying the code that reads it.

ALTER TABLE "ServiceOffering" ADD COLUMN IF NOT EXISTS "maxNsfwLevel" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "ServiceDeal" ADD COLUMN IF NOT EXISTS "maxNsfwLevel" INTEGER NOT NULL DEFAULT 2;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceOffering_maxNsfwLevel_one_level') THEN
    ALTER TABLE "ServiceOffering" ADD CONSTRAINT "ServiceOffering_maxNsfwLevel_one_level"
      CHECK ("maxNsfwLevel" IN (1, 2, 4, 8, 16));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceDeal_maxNsfwLevel_one_level') THEN
    ALTER TABLE "ServiceDeal" ADD CONSTRAINT "ServiceDeal_maxNsfwLevel_one_level"
      CHECK ("maxNsfwLevel" IN (1, 2, 4, 8, 16));
  END IF;
  -- A mature deal is only ever requested where green Buzz is not spent.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceDeal_mature_not_green') THEN
    ALTER TABLE "ServiceDeal" ADD CONSTRAINT "ServiceDeal_mature_not_green"
      CHECK ("maxNsfwLevel" <= 2 OR "buzzType" <> 'green'::"ServiceBuzzType");
  END IF;
END $$;
