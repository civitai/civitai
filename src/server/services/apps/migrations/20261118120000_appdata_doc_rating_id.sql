-- App Blocks document store: a numeric RATING ID for shared documents, and the rater's lookup
-- policy. MANUAL-APPLY migration.
--
-- TARGET DATABASE: the App Blocks datastore, the same one
--   `20261013120000_appdata_document_store.sql` was applied to (NOT the main civitai
--   database). Apply it by hand (psql) as the role that owns the `appdata` tables, once per
--   environment. Nothing applies this automatically. Its companion
--   `20261118120100_appdata_doc_rating_id_idx.sql` builds the lookup index; apply it right after.
--
-- WHY: content levels (build 3) rate a shared document's text with the text scan, whose verdict
--   rows, callbacks and retries are keyed on an integer entity id. A document's key is
--   (app_id, ns, coll, scope_uid, key), so the rater gives each shared document it rates an
--   integer id the first time it rates it:
--   - `appdata.doc_rating_id_seq`  where the ids come from;
--   - `doc.rating_id`              the id, NULL until the rater first rates the document. A
--                                  deleted and re-created key gets a new id.
--   - policy `appdata_rater_lookup` one read-only policy on `doc`: a transaction that sets
--                                  `appdata.rater_lookup_id` to an id may READ the one shared row
--                                  carrying that id. That is how a scan's callback finds the
--                                  document; it then reads and writes it in an ordinary
--                                  (app, namespace)-scoped transaction. Nothing else: no other
--                                  row, no other table, no insert, update or delete. Only
--                                  `raterLookupTx` in `doc-store.ts` sets the setting.
--
-- SAFE BEFORE THE CODE: additive only. A nullable column with no default (catalog-only), a
--   sequence, a grant and a policy that admits nothing until the setting is set. Until this is
--   applied the rater does nothing (the rater's `ready` checks `pg_policies` for this policy).
--
-- Same lock discipline as `20261116120000_appdata_doc_levels.sql`: a 1s lock_timeout, below the
--   store's own 3s. If the ALTER times out, re-run it.
--
-- IDEMPOTENT: IF NOT EXISTS, and the policy is dropped and re-created. ROLLBACK: the sibling
--   `20261118120000_appdata_doc_rating_id.down.sql`.

BEGIN;
SET LOCAL lock_timeout = '1s';

CREATE SEQUENCE IF NOT EXISTS appdata.doc_rating_id_seq AS integer;
ALTER TABLE appdata.doc ADD COLUMN IF NOT EXISTS rating_id integer;
GRANT USAGE ON SEQUENCE appdata.doc_rating_id_seq TO appdata_rw;

DROP POLICY IF EXISTS appdata_rater_lookup ON appdata.doc;
-- NULLIF folds an unset or ended setting ('' on a reused connection) to NULL, so the predicate is
-- NULL and admits nothing, as in the document-store migration.
CREATE POLICY appdata_rater_lookup ON appdata.doc FOR SELECT
  USING (scope_uid = 0
    AND rating_id = NULLIF(current_setting('appdata.rater_lookup_id', true), '')::integer);

COMMIT;
