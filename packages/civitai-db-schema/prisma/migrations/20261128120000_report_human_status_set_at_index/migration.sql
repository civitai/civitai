-- When a moderator last actioned each report type (moderator app: sidebar badges, Needs attention).
--
-- The lookup reads the last week of report reviews (Actioned or Unactioned) by anyone but the system
-- user (-1), whose expiry run closes most reports. No index on "Report" covers "statusSetAt", so it
-- seq-scanned the whole table to find them.
--
-- -1 is SYSTEM_USER_ID (apps/moderator/src/lib/server/users.service.ts). The query spells the same
-- literal so the planner can match this partial index: change both or neither.
--
-- Apply before the deploy if you can. Without the index the lookup can outrun its time limit, and the
-- badges are then left off until it answers.
--
-- Run OUTSIDE a transaction (CONCURRENTLY cannot run inside one). A cancelled build leaves an invalid
-- index under this name, which IF NOT EXISTS then skips: check pg_index.indisvalid after applying, and
-- if false, DROP INDEX CONCURRENTLY and run this again.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Report_human_statusSetAt_idx"
  ON "Report" ("statusSetAt")
  WHERE "statusSetBy" <> -1;
