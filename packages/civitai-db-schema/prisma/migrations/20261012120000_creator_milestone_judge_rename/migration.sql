-- Idempotent: applied by hand, possibly more than once.
--
-- Renames the Crucible judging milestones from metal tiers to counts, matching the other count
-- tracks ('1k Downloads', '10k Followers'): lowercase k, and each badge named '<name> Creator Badge'.
-- Text only; keys, thresholds and badge art are unchanged. Each row is matched by key or id, since
-- the badge ids are not in threshold order.
--
-- After applying, evict the five badge ids from the cosmetic cache, which holds names for a day.

BEGIN;

SET LOCAL lock_timeout = '3s';

UPDATE "CreatorMilestone" m
SET "name" = v.name
FROM (VALUES
  ('community:crucible-votes-500',   '500 Judged'),
  ('community:crucible-votes-1000',  '1k Judged'),
  ('community:crucible-votes-5000',  '5k Judged'),
  ('community:crucible-votes-10000', '10k Judged'),
  ('community:crucible-votes-25000', '25k Judged')
) AS v(key, name)
WHERE m."key" = v.key AND m."name" IS DISTINCT FROM v.name;

UPDATE "Cosmetic" c
SET "name" = m."name" || ' Creator Badge'
FROM "CreatorMilestone" m
WHERE m."cosmeticId" = c.id
  AND m."key" LIKE 'community:crucible-votes-%'
  AND c."name" IS DISTINCT FROM m."name" || ' Creator Badge';

COMMIT;
