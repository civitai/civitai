-- Rollback of `20261118120100_appdata_doc_rating_id_idx.sql`. Not in a transaction block.
DROP INDEX CONCURRENTLY IF EXISTS appdata.doc_rating_id_key;
