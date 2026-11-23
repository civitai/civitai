-- Rollback of `20261122120000_appdata_mark_head.sql`: drops the `mark_seq` column of
-- `appdata.doc_tally`, then `appdata.mark_head` (its policies go with it). No document, tally
-- count or mark is touched; every mark sequence is lost.
--
-- Safe with the code live: a store that had found the table fails the one mark, unmark or
-- increment in flight when it goes, then finds it missing and answers without a sequence.
--
-- Same 1s lock_timeout as the up migration. If it times out, re-run it.

BEGIN;
SET LOCAL lock_timeout = '1s';
ALTER TABLE appdata.doc_tally DROP COLUMN IF EXISTS mark_seq;
DROP TABLE IF EXISTS appdata.mark_head;
COMMIT;
