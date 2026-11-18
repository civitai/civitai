-- App Blocks document store: a `record_id` column on `appdata.doc`. MANUAL-APPLY migration.
--
-- TARGET DATABASE: the App Blocks datastore, the same one
--   `20261013120000_appdata_document_store.sql` was applied to (NOT the main civitai
--   database). Apply it by hand (psql) as the role that owns the `appdata` tables, once per
--   environment. Nothing applies this automatically.
--
-- WHAT IT ADDS: `record_id`, a random opaque id per document row. It is the id in a PRIVATE
--   record's URN (`services/apps/app-record.ts`): a private collection is one key space per
--   user, so its keys are not unique within the collection and cannot name a record on their
--   own. Shared records keep their document key and never read this column. Nothing reads it
--   yet; the store's write path does not name it.
--
-- TWO CATALOG-ONLY STEPS: the column is added nullable with no default (no table rewrite), then
--   given the default `gen_random_uuid()`, which applies to rows inserted from then on only (an
--   ALTER COLUMN … SET DEFAULT never touches existing rows). So new rows get an id with no code
--   change, and existing rows keep NULL until the backfill
--   (`20261118120100_appdata_doc_record_id_backfill.sql`) fills them. `gen_random_uuid()` is in
--   core Postgres from 13 on; on an older server it needs `pgcrypto`, and this fails without it.
--
-- Same lock discipline as `20261106130000_appdata_doc_schema_major.sql`: each ALTER needs a brief
--   ACCESS EXCLUSIVE lock on `appdata.doc`, so `lock_timeout` is 1s, below the store's own 3s; if
--   it times out, re-run. The existing grants and row-level policies cover the new column.
--
-- ROLLOUT ORDER: this, then the backfill, then the unique index
--   (`20261118120200_appdata_doc_record_id_unique.sql`). Safe before or after any code ships.
--
-- IDEMPOTENT: IF NOT EXISTS, and setting the same default again is a no-op. ROLLBACK: the
--   sibling `20261118120000_appdata_doc_record_id.down.sql`.

BEGIN;
SET LOCAL lock_timeout = '1s';
ALTER TABLE appdata.doc ADD COLUMN IF NOT EXISTS record_id uuid;
ALTER TABLE appdata.doc ALTER COLUMN record_id SET DEFAULT gen_random_uuid();
COMMIT;
