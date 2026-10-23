-- App Blocks document store — the `appdata` schema. MANUAL-APPLY migration.
--
-- TARGET DATABASE: the App Blocks datastore (the database `APPS_DATABASE_URL`
--   points at — the same one that holds the per-app `app_<slug>` schemas), NOT
--   the main civitai database. Apply it by hand (psql) as a role that can
--   create schemas and roles, once per environment that has that datastore.
--   Nothing applies this automatically: not CI, not a deploy, not the app.
--
-- WHAT IT CREATES: one fixed schema `appdata` with seven tables shared by every
--   app (an `app_id` column, not a schema per app), their indexes, row-level
--   security policies, and one NOLOGIN role `appdata_rw` holding the DML grants.
--
-- CONNECTION: the document store uses its OWN connection, `APPDATA_DATABASE_URL`,
--   never the existing apps connection. Its login role is provisioned outside
--   this migration (see the operations runbook); it must hold only `appdata_rw`
--   and be neither superuser nor BYPASSRLS, so row-level security binds it.
--   The store checks those two attributes on first use and refuses every call
--   (`storage_disabled`) if either is true; with the env var unset it is
--   disabled outright.
--
-- ISOLATION: the only code that touches these tables is
--   `src/server/services/apps/doc-store.ts`. Every statement there carries
--   `app_id = $1 AND ns = $2` (pinned by `__tests__/doc-store.sql-isolation.test.ts`),
--   and the policies below refuse any row whose `(app_id, ns)` differs from the
--   transaction-local settings `appdata.app_id` / `appdata.ns` that the module sets
--   with `set_config(…, true)` (`SET LOCAL` semantics) at the start of every
--   transaction. A statement run without those settings sees no rows and cannot
--   insert any.
--
--   The first exception is REVIEW MAINTENANCE: deleting the review namespaces
--   (`rev:<publishRequestId>:<moderatorUid>`) of a decided publish request. A
--   transaction that also sets `appdata.review_maintenance` to 'on' may read and
--   delete rows whose `ns` starts with `rev:` AND whose `app_id` is the request
--   in `appdata.app_id`; bound to no request, it may read the review rows of any
--   app on `doc` and `usage_app` (read only), which is how the sweep finds
--   requests to purge. It can never
--   see or touch a `prod` or `dev:` row, and never insert or update anything.
--   Only the purge and sweep functions in `doc-store.ts` set it.
--
--   The other exception is ACCOUNT WIPE enumeration: finding every (app, namespace)
--   in which one wiped account has rows. A transaction that sets
--   `appdata.account_wipe_uid` to a user id may READ the `usage_user` and
--   `doc_mark` rows of that ONE user, in every app and namespace. Nothing else:
--   no other table, no other user, no insert, update or delete. The wipe itself
--   then runs one ordinary (app, ns)-scoped transaction per namespace found.
--   Only the account-wipe enumeration in `doc-store.ts` sets it.
--
-- IDEMPOTENT: every statement is IF NOT EXISTS, or a DROP IF EXISTS + CREATE
--   inside this one transaction; safe to re-run. ROLLBACK: the sibling file
--   `20261013120000_appdata_document_store.down.sql` (destroys all data in it).
--
-- No per-app DDL exists anywhere: approving an app, adding a collection or adding
-- an index is DML only.

BEGIN;

CREATE SCHEMA IF NOT EXISTS appdata;

-- Every identifier and key column is COLLATE "C": ordering is bytewise, so list
-- order, keyset cursors and key-prefix ranges do not depend on the server's
-- locale, and a prefix scan can use the primary-key btree.

-- One row per document. `scope_uid` is 0 for a shared collection and the viewer's
-- user id for a private one, so a private collection is one key space per viewer.
CREATE TABLE IF NOT EXISTS appdata.doc (
  app_id          text COLLATE "C" NOT NULL,
  ns              text COLLATE "C" NOT NULL,
  coll            text COLLATE "C" NOT NULL,
  scope_uid       integer NOT NULL,
  key             text COLLATE "C" NOT NULL,
  data            jsonb NOT NULL,
  -- The quota unit and the per-document cap are both measured on this column:
  -- the canonical text of the stored jsonb. `octet_length(jsonb::text)` is
  -- IMMUTABLE (a generated column requires that; `pg_column_size` is only
  -- STABLE and would also move with TOAST compression settings). Because the
  -- cap below is a CHECK on the same number the quota counters add up, no
  -- payload can pass a cap measured in one unit and be charged in another.
  size_bytes      integer GENERATED ALWAYS AS (octet_length(data::text)) STORED,
  version         integer NOT NULL,
  seq             bigint NOT NULL,
  author_uid      integer,
  author_kind     text COLLATE "C" NOT NULL,
  last_writer_uid integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  hidden_at       timestamptz,
  hidden_by       integer,
  CONSTRAINT doc_scope_nonempty CHECK (app_id <> '' AND ns <> ''),
  CONSTRAINT doc_pkey PRIMARY KEY (app_id, ns, coll, scope_uid, key),
  CONSTRAINT doc_size_cap CHECK (size_bytes <= 65536),
  -- 'counter': created by the first increment of a counter; no user author.
  CONSTRAINT doc_author_kind CHECK (author_kind IN ('user', 'app', 'counter')),
  CONSTRAINT doc_version_positive CHECK (version >= 1)
);

-- When a moderator last dismissed the document's reports (reviewed and kept): only report
-- marks made after it count as open. NULL = never dismissed. A separate ADD COLUMN so a
-- re-apply over a table created before the column existed still adds it.
ALTER TABLE appdata.doc ADD COLUMN IF NOT EXISTS reports_dismissed_at timestamptz;
-- The moderators' hidden view: hidden documents only (few), so it never reads the whole app.
CREATE INDEX IF NOT EXISTS doc_hidden_idx
  ON appdata.doc (app_id, ns, scope_uid, coll, key) WHERE hidden_at IS NOT NULL;

-- `author=me` lists.
CREATE INDEX IF NOT EXISTS doc_author_idx
  ON appdata.doc (app_id, ns, coll, scope_uid, author_uid, key);
CREATE INDEX IF NOT EXISTS doc_created_idx
  ON appdata.doc (app_id, ns, coll, scope_uid, created_at, key);
CREATE INDEX IF NOT EXISTS doc_updated_idx
  ON appdata.doc (app_id, ns, coll, scope_uid, updated_at, key);
-- The TTL reaper scans only rows that can expire.
CREATE INDEX IF NOT EXISTS doc_expires_idx
  ON appdata.doc (expires_at) WHERE expires_at IS NOT NULL;

-- Declared indexes, one row per (doc, index name). A side table rather than
-- expression indexes, which would be per-app DDL.
--
-- `v_type` is the index type the row was written under. Number, boolean and
-- time all store into `v_num`, so without it a row written under an earlier
-- type of the same index name (a `1` written as number) would match a filter or
-- sort under the current type (`true` as boolean). Every read joins on it.
-- It is NOT in the primary key: there is exactly one row per (doc, name), so a
-- re-declared type replaces the row on the document's next write instead of a
-- stale row of the old type living beside it.
CREATE TABLE IF NOT EXISTS appdata.doc_index (
  app_id    text COLLATE "C" NOT NULL,
  ns        text COLLATE "C" NOT NULL,
  coll      text COLLATE "C" NOT NULL,
  scope_uid integer NOT NULL,
  name      text COLLATE "C" NOT NULL,
  key       text COLLATE "C" NOT NULL,
  v_type    text COLLATE "C" NOT NULL,
  v_text    text COLLATE "C",
  v_num     double precision,
  -- Key before name: index maintenance and the cascade from `doc` look rows up by
  -- document; access by index name goes through the two btrees below.
  CONSTRAINT doc_index_scope_nonempty CHECK (app_id <> '' AND ns <> ''),
  CONSTRAINT doc_index_pkey PRIMARY KEY (app_id, ns, coll, scope_uid, key, name),
  CONSTRAINT doc_index_doc_fkey FOREIGN KEY (app_id, ns, coll, scope_uid, key)
    REFERENCES appdata.doc (app_id, ns, coll, scope_uid, key) ON DELETE CASCADE,
  CONSTRAINT doc_index_type CHECK (v_type IN ('string', 'number', 'boolean', 'time')),
  -- A string lives in v_text and every other type in v_num, never both.
  CONSTRAINT doc_index_value_column CHECK (
    CASE WHEN v_type = 'string'
      THEN v_text IS NOT NULL AND v_num IS NULL
      ELSE v_num IS NOT NULL AND v_text IS NULL
    END)
);
-- `v_type` follows `name` so a typed filter or sort is still one index range.
CREATE INDEX IF NOT EXISTS doc_index_text_idx
  ON appdata.doc_index (app_id, ns, coll, scope_uid, name, v_type, v_text, key);
CREATE INDEX IF NOT EXISTS doc_index_num_idx
  ON appdata.doc_index (app_id, ns, coll, scope_uid, name, v_type, v_num, key);

-- Counters and mark counts. `kind` is in the primary key, so a counter and a mark
-- of the same name on the same document are separate rows and incrementing a
-- counter can never move a mark count. Tallies exist on shared documents only.
CREATE TABLE IF NOT EXISTS appdata.doc_tally (
  app_id text COLLATE "C" NOT NULL,
  ns     text COLLATE "C" NOT NULL,
  coll   text COLLATE "C" NOT NULL,
  key    text COLLATE "C" NOT NULL,
  kind   text COLLATE "C" NOT NULL,
  name   text COLLATE "C" NOT NULL,
  count  bigint NOT NULL DEFAULT 0,
  CONSTRAINT doc_tally_scope_nonempty CHECK (app_id <> '' AND ns <> ''),
  CONSTRAINT doc_tally_pkey PRIMARY KEY (app_id, ns, coll, key, kind, name),
  CONSTRAINT doc_tally_kind CHECK (kind IN ('counter', 'mark')),
  CONSTRAINT doc_tally_nonnegative CHECK (count >= 0)
);
-- "Top N by counter/mark" lists.
CREATE INDEX IF NOT EXISTS doc_tally_top_idx
  ON appdata.doc_tally (app_id, ns, coll, kind, name, count, key);

-- One row per (doc, mark name, user): the uniqueness that makes a mark count
-- equal the number of distinct users who marked.
CREATE TABLE IF NOT EXISTS appdata.doc_mark (
  app_id     text COLLATE "C" NOT NULL,
  ns         text COLLATE "C" NOT NULL,
  coll       text COLLATE "C" NOT NULL,
  key        text COLLATE "C" NOT NULL,
  name       text COLLATE "C" NOT NULL,
  user_id    integer NOT NULL,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT doc_mark_scope_nonempty CHECK (app_id <> '' AND ns <> ''),
  CONSTRAINT doc_mark_pkey PRIMARY KEY (app_id, ns, coll, key, name, user_id)
);
-- The moderators' report queue: every mark of ONE name in an app (`report`), without reading
-- the app's other marks. Neither the primary key nor `doc_mark_user_idx` has `name` right
-- after (app_id, ns). One more btree entry per mark write.
CREATE INDEX IF NOT EXISTS doc_mark_name_idx
  ON appdata.doc_mark (app_id, ns, name, coll, key);
-- `markedBy=me` lists and account deletion.
CREATE INDEX IF NOT EXISTS doc_mark_user_idx
  ON appdata.doc_mark (app_id, ns, coll, user_id, name, key);

-- Deletion tombstones for the change feed; reaped after 7 days.
CREATE TABLE IF NOT EXISTS appdata.doc_tomb (
  app_id     text COLLATE "C" NOT NULL,
  ns         text COLLATE "C" NOT NULL,
  coll       text COLLATE "C" NOT NULL,
  scope_uid  integer NOT NULL,
  key        text COLLATE "C" NOT NULL,
  seq        bigint NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT doc_tomb_scope_nonempty CHECK (app_id <> '' AND ns <> ''),
  CONSTRAINT doc_tomb_pkey PRIMARY KEY (app_id, ns, coll, scope_uid, key)
);
CREATE INDEX IF NOT EXISTS doc_tomb_deleted_idx ON appdata.doc_tomb (deleted_at);

-- Per-(app, namespace) usage. The row is also the lock that orders `seq`: it is
-- updated, and so row-locked until commit, by every document write.
CREATE TABLE IF NOT EXISTS appdata.usage_app (
  app_id   text COLLATE "C" NOT NULL,
  ns       text COLLATE "C" NOT NULL,
  bytes    bigint NOT NULL DEFAULT 0,
  docs     integer NOT NULL DEFAULT 0,
  last_seq bigint NOT NULL DEFAULT 0,
  CONSTRAINT usage_app_scope_nonempty CHECK (app_id <> '' AND ns <> ''),
  CONSTRAINT usage_app_pkey PRIMARY KEY (app_id, ns)
);

-- Per-(app, namespace, user) usage: a private doc is charged to its viewer, a
-- user-authored shared doc to its author.
CREATE TABLE IF NOT EXISTS appdata.usage_user (
  app_id  text COLLATE "C" NOT NULL,
  ns      text COLLATE "C" NOT NULL,
  user_id integer NOT NULL,
  bytes   bigint NOT NULL DEFAULT 0,
  docs    integer NOT NULL DEFAULT 0,
  CONSTRAINT usage_user_scope_nonempty CHECK (app_id <> '' AND ns <> ''),
  CONSTRAINT usage_user_pkey PRIMARY KEY (app_id, ns, user_id)
);

-- Row-level security: the second isolation layer. FORCE makes it bind the table
-- owner too; it never binds a superuser or a BYPASSRLS role.
DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['doc', 'doc_index', 'doc_tally', 'doc_mark', 'doc_tomb', 'usage_app', 'usage_user']
  LOOP
    EXECUTE format('ALTER TABLE appdata.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE appdata.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS appdata_scope ON appdata.%I', t);
    -- `current_setting(…, true)` is NULL when the setting was never set in the
    -- session, but '' on a connection where a transaction once set it with
    -- SET LOCAL semantics and ended. NULLIF folds both to NULL, so the predicate
    -- is NULL (not true) and the row is invisible / the write refused. The
    -- `*_scope_nonempty` CHECKs make '' an impossible stored value as well.
    EXECUTE format(
      'CREATE POLICY appdata_scope ON appdata.%I '
      'USING (app_id = NULLIF(current_setting(''appdata.app_id'', true), '''') '
      'AND ns = NULLIF(current_setting(''appdata.ns'', true), '''')) '
      'WITH CHECK (app_id = NULLIF(current_setting(''appdata.app_id'', true), '''') '
      'AND ns = NULLIF(current_setting(''appdata.ns'', true), ''''))',
      t);
    -- Review maintenance (see the header). Read and delete only: no INSERT or
    -- UPDATE policy admits it, so WITH CHECK stays the scope policy's alone.
    EXECUTE format('DROP POLICY IF EXISTS appdata_review_read ON appdata.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS appdata_review_delete ON appdata.%I', t);
    -- Reads are keyed on the bound request like deletes, except that on `doc` and
    -- `usage_app` a transaction bound to NO request may read every app's review rows: that is
    -- the sweep's listing of requests that still hold review data.
    EXECUTE format(
      'CREATE POLICY appdata_review_read ON appdata.%I FOR SELECT '
      'USING (current_setting(''appdata.review_maintenance'', true) = ''on'' '
      'AND ns LIKE ''rev:%%'' '
      'AND (app_id = NULLIF(current_setting(''appdata.app_id'', true), '''')%s))',
      t,
      CASE WHEN t IN ('doc', 'usage_app')
        THEN ' OR NULLIF(current_setting(''appdata.app_id'', true), '''') IS NULL'
        ELSE '' END);
    EXECUTE format(
      'CREATE POLICY appdata_review_delete ON appdata.%I FOR DELETE '
      'USING (current_setting(''appdata.review_maintenance'', true) = ''on'' '
      'AND ns LIKE ''rev:%%'' '
      'AND app_id = NULLIF(current_setting(''appdata.app_id'', true), ''''))',
      t);
  END LOOP;
  -- Account-wipe enumeration (see the header): read only, the rows of the ONE user in
  -- `appdata.account_wipe_uid`, on the two tables that record which namespaces a user has
  -- data in. Compared as text so a malformed setting matches nothing instead of erroring;
  -- NULLIF folds an unset or ended setting ('' on a reused connection) to NULL, as above.
  FOREACH t IN ARRAY ARRAY['doc_mark', 'usage_user']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS appdata_account_wipe_read ON appdata.%I', t);
    EXECUTE format(
      'CREATE POLICY appdata_account_wipe_read ON appdata.%I FOR SELECT '
      'USING (user_id::text = NULLIF(current_setting(''appdata.account_wipe_uid'', true), ''''))',
      t);
  END LOOP;
END
$rls$;

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'appdata_rw') THEN
    CREATE ROLE appdata_rw NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$role$;

GRANT USAGE ON SCHEMA appdata TO appdata_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA appdata TO appdata_rw;

COMMIT;
