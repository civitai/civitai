-- Rollback of `20261122120000_appdata_mark_head.sql`: drops the `mark_seq` columns of
-- `appdata.doc_tally` and `appdata.doc_mark`, then `appdata.mark_head` (its policies go with it).
-- No document, tally count or mark is touched; every mark sequence is lost.
--
-- 🔴 Roll the CODE back first: a release that takes the mark sequence names the table and the
-- columns on every mark, unmark and increment, and refuses each of them once they are gone.
--
-- Same 1s lock_timeout as the up migration. If it times out, re-run it.

BEGIN;
SET LOCAL lock_timeout = '1s';
ALTER TABLE appdata.doc_mark DROP COLUMN IF EXISTS mark_seq;
ALTER TABLE appdata.doc_tally DROP COLUMN IF EXISTS mark_seq;
DROP TABLE IF EXISTS appdata.mark_head;
COMMIT;
