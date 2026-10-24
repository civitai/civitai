-- Idempotent: applied by hand, possibly more than once.
--
-- Creator Journey activity milestones, Create and Reach tracks. Definitions only: grants come from the
-- grant-creator-milestones job. Badge cosmetics are attached later (cosmeticId stays NULL here).
--
-- 🔴 APPLY BEFORE THE CODE THAT GRANTS THESE KEYS DEPLOYS: a grant for a key with no row fails its FK.

SET lock_timeout = '3s';

BEGIN;

SET LOCAL lock_timeout = '3s';

INSERT INTO "CreatorMilestone" ("key", "track", "threshold", "name", "description", "sortOrder")
VALUES
  ('create:models-1',          'create',       1, 'First Model',    'Published your first model.',                 1),
  ('create:models-5',          'create',       5, '5 Models',       'Published 5 models.',                         2),
  ('create:models-25',         'create',      25, '25 Models',      'Published 25 models.',                        3),
  ('create:models-100',        'create',     100, '100 Models',     'Published 100 models.',                       4),
  ('create:articles-1',        'create',       1, 'First Article',  'Published your first article.',               5),
  ('create:articles-5',        'create',       5, '5 Articles',     'Published 5 articles.',                       6),
  ('create:articles-25',       'create',      25, '25 Articles',    'Published 25 articles.',                      7),
  ('reach:downloads-100',      'reach',      100, '100 Downloads',  'One of your models reached 100 downloads.',   1),
  ('reach:downloads-1000',     'reach',     1000, '1k Downloads',   'One of your models reached 1,000 downloads.', 2),
  ('reach:downloads-10000',    'reach',    10000, '10k Downloads',  'One of your models reached 10,000 downloads.', 3),
  ('reach:downloads-100000',   'reach',   100000, '100k Downloads', 'One of your models reached 100,000 downloads.', 4),
  ('reach:followers-100',      'reach',      100, '100 Followers',  'Reached 100 followers.',                      5),
  ('reach:followers-1000',     'reach',     1000, '1k Followers',   'Reached 1,000 followers.',                    6),
  ('reach:followers-10000',    'reach',    10000, '10k Followers',  'Reached 10,000 followers.',                   7),
  ('reach:reactions-1000',     'reach',     1000, '1k Reactions',   'Your work received 1,000 reactions.',         8),
  ('reach:reactions-10000',    'reach',    10000, '10k Reactions',  'Your work received 10,000 reactions.',        9),
  ('reach:reactions-100000',   'reach',   100000, '100k Reactions', 'Your work received 100,000 reactions.',       10),
  ('reach:reactions-1000000',  'reach',  1000000, '1M Reactions',   'Your work received 1,000,000 reactions.',     11)
ON CONFLICT ("key") DO NOTHING;

COMMIT;
