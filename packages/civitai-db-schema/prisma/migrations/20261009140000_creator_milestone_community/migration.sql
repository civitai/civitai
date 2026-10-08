-- Idempotent: applied by hand, possibly more than once.
--
-- Creator Journey Community track, first measure: Crucible votes cast as a judge. Definitions only:
-- grants come from the grant-creator-milestones job. Badge cosmetics are attached later (cosmeticId
-- stays NULL here).
--
-- 🔴 APPLY BEFORE THE CODE THAT GRANTS THESE KEYS DEPLOYS: the job refuses a group with a missing row.

BEGIN;

SET LOCAL lock_timeout = '3s';

INSERT INTO "CreatorMilestone" ("key", "track", "threshold", "name", "description", "sortOrder")
VALUES
  ('community:crucible-votes-500',   'community',   500, 'Bronze Judge',   'Cast 500 votes judging Crucibles.',    1),
  ('community:crucible-votes-1000',  'community',  1000, 'Silver Judge',   'Cast 1,000 votes judging Crucibles.',  2),
  ('community:crucible-votes-5000',  'community',  5000, 'Gold Judge',     'Cast 5,000 votes judging Crucibles.',  3),
  ('community:crucible-votes-10000', 'community', 10000, 'Platinum Judge', 'Cast 10,000 votes judging Crucibles.', 4),
  ('community:crucible-votes-25000', 'community', 25000, 'Diamond Judge',  'Cast 25,000 votes judging Crucibles.', 5)
ON CONFLICT ("key") DO NOTHING;

COMMIT;
