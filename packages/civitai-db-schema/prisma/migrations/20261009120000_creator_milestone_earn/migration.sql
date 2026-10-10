-- Idempotent: applied by hand, possibly more than once.
--
-- Creator Journey Earn track: gross creator-shop sales, in Buzz. Definitions only: grants come from the
-- grant-creator-milestones job. Badge cosmetics are attached later (cosmeticId stays NULL here).
--
-- 🔴 APPLY BEFORE THE CODE THAT GRANTS THESE KEYS DEPLOYS: the job refuses a group with a missing row.

BEGIN;

SET LOCAL lock_timeout = '3s';

INSERT INTO "CreatorMilestone" ("key", "track", "threshold", "name", "description", "sortOrder")
VALUES
  ('earn:shop-sales-100000',  'earn',  100000, '100k Sales', 'Sold 100,000 Buzz from your shop.',   1),
  ('earn:shop-sales-250000',  'earn',  250000, '250k Sales', 'Sold 250,000 Buzz from your shop.',   2),
  ('earn:shop-sales-500000',  'earn',  500000, '500k Sales', 'Sold 500,000 Buzz from your shop.',   3),
  ('earn:shop-sales-1000000', 'earn', 1000000, '1M Sales',   'Sold 1,000,000 Buzz from your shop.', 4),
  ('earn:shop-sales-2000000', 'earn', 2000000, '2M Sales',   'Sold 2,000,000 Buzz from your shop.', 5)
ON CONFLICT ("key") DO NOTHING;

COMMIT;
