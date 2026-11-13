-- Idempotent: applied by hand, possibly more than once.
--
-- Creator Journey Compete track: wins, a prize place in a challenge or Crucible someone else ran.
-- Definitions only: grants come from the grant-creator-milestones job. Badge cosmetics are attached
-- later (cosmeticId stays NULL here).
--
-- 🔴 APPLY BEFORE THE CODE THAT GRANTS THESE KEYS DEPLOYS: the job refuses a group with a missing row.

BEGIN;

SET LOCAL lock_timeout = '3s';

INSERT INTO "CreatorMilestone" ("key", "track", "threshold", "name", "description", "sortOrder")
VALUES
  ('compete:wins-1',   'compete',   1, 'First Win', 'Finish in the prize places of a challenge or Crucible.',     1),
  ('compete:wins-5',   'compete',   5, '5 Wins',    'Finish in the prize places of 5 challenges or Crucibles.',   2),
  ('compete:wins-10',  'compete',  10, '10 Wins',   'Finish in the prize places of 10 challenges or Crucibles.',  3),
  ('compete:wins-25',  'compete',  25, '25 Wins',   'Finish in the prize places of 25 challenges or Crucibles.',  4),
  ('compete:wins-50',  'compete',  50, '50 Wins',   'Finish in the prize places of 50 challenges or Crucibles.',  5),
  ('compete:wins-100', 'compete', 100, '100 Wins',  'Finish in the prize places of 100 challenges or Crucibles.', 6)
ON CONFLICT ("key") DO NOTHING;

COMMIT;
