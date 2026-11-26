-- Rollback of `20261123120000_appdata_maint_run.sql`: drops `appdata.maint_run` (its policies go
-- with it). No document, tally or mark is touched. Every run record is lost: every mark freeze
-- lifts at once (the old `$mark` / `$unmark` answer again), and every purge dump is gone. Copy
-- the purge rows out first (`SELECT * FROM appdata.maint_run WHERE kind = 'purge'`) if they are
-- still needed.
--
-- Safe with the code live: a store that had found the table fails the one call in flight when it
-- goes, then finds it missing and runs as before it existed.
--
-- Same 1s lock_timeout as the up migration. If it times out, re-run it.

BEGIN;
SET LOCAL lock_timeout = '1s';
DROP TABLE IF EXISTS appdata.maint_run;
COMMIT;
