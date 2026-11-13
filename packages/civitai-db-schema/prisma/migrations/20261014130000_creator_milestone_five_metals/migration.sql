-- Idempotent: applied by hand, possibly more than once.
--
-- Creator Journey ladders run wood -> bronze -> silver -> gold -> diamond: five rungs each. Adds the
-- seven new rungs, removes compete:wins-50 (never granted), and re-numbers sortOrder so each ladder
-- reads in threshold order. Definitions only; badge cosmetics are linked separately.
--
-- 🔴 APPLY BEFORE THE CODE THAT GRANTS THESE KEYS DEPLOYS: the job refuses a group with a missing row.
-- 🔴 compete:wins-50 is only deleted while nobody holds it; otherwise the whole migration aborts.

BEGIN;

SET LOCAL lock_timeout = '3s';

INSERT INTO "CreatorMilestone" ("key", "track", "threshold", "name", "description", "sortOrder")
VALUES
  ('create:models-500',       'create',     500, '500 Models',    'Published 500 models.',                         5),
  ('create:articles-50',      'create',      50, '50 Articles',   'Published 50 articles.',                        9),
  ('create:articles-100',     'create',     100, '100 Articles',  'Published 100 articles.',                      10),
  ('reach:downloads-1000000', 'reach',  1000000, '1M Downloads',  'One of your models reached 1,000,000 downloads.', 5),
  ('reach:followers-500',     'reach',      500, '500 Followers', 'Reached 500 followers.',                        7),
  ('reach:followers-5000',    'reach',     5000, '5k Followers',  'Reached 5,000 followers.',                      9),
  ('reach:reactions-100',     'reach',      100, '100 Reactions', 'Your work received 100 reactions.',            11)
ON CONFLICT ("key") DO NOTHING;

DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM "UserCreatorMilestone" WHERE "milestoneKey" = 'compete:wins-50') THEN
    RAISE EXCEPTION 'compete:wins-50 has holders; not deleting it';
  END IF;
END
$g$;

DELETE FROM "CreatorMilestoneCosmetic" WHERE "milestoneKey" = 'compete:wins-50';
DELETE FROM "CreatorMilestone" WHERE "key" = 'compete:wins-50';

UPDATE "CreatorMilestone" m
SET "sortOrder" = v.sort
FROM (VALUES
  ('create:models-1', 1), ('create:models-5', 2), ('create:models-25', 3), ('create:models-100', 4),
  ('create:models-500', 5),
  ('create:articles-1', 6), ('create:articles-5', 7), ('create:articles-25', 8),
  ('create:articles-50', 9), ('create:articles-100', 10),
  ('reach:downloads-100', 1), ('reach:downloads-1000', 2), ('reach:downloads-10000', 3),
  ('reach:downloads-100000', 4), ('reach:downloads-1000000', 5),
  ('reach:followers-100', 6), ('reach:followers-500', 7), ('reach:followers-1000', 8),
  ('reach:followers-5000', 9), ('reach:followers-10000', 10),
  ('reach:reactions-100', 11), ('reach:reactions-1000', 12), ('reach:reactions-10000', 13),
  ('reach:reactions-100000', 14), ('reach:reactions-1000000', 15),
  ('compete:wins-1', 1), ('compete:wins-5', 2), ('compete:wins-10', 3), ('compete:wins-25', 4),
  ('compete:wins-100', 5)
) AS v(key, sort)
WHERE m."key" = v.key AND m."sortOrder" IS DISTINCT FROM v.sort;

COMMIT;
