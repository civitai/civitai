-- App Blocks SHARED (app-global / cross-user) storage — manual-apply migration.
--
-- TARGET DATABASE: the App Blocks datastore  (appsDb / cnpg-cluster-apps), NOT
--   the main civitai CNPG nvme0 DB. This DB holds the per-app `app_<slug>`
--   schemas provisioned by AppStorageProvisioner. Apply to:
--     - prod  appsDb  (cnpg-cluster-apps)
--     - the writable weekly dev clone of appsDb (if one exists for this DB)
--   Per datapacket-talos rule #8: this is written for history + is applied
--   MANUALLY by a human (psql), never auto-run by CI/deploy.
--
-- WHAT IT DOES: idempotent BACKFILL of the shared_kv / votes / counters /
--   shared_kv_reports tables + the shared_kv quota trigger + role grants onto
--   EVERY already-provisioned `app_<slug>` schema. NEW apps get these tables
--   automatically the next time AppStorageProvisioner.provision() runs (webhook
--   on approved version push, or the P7 backfill job) — this script covers apps
--   provisioned BEFORE the code shipped so they don't wait for a re-provision.
--
-- IDEMPOTENT: every statement is IF NOT EXISTS / OR REPLACE, safe to re-run.
--
-- The DDL below MUST stay byte-equivalent to the shared-table DDL in
--   src/server/services/apps/storage-provision.service.ts — that service is the
--   source of truth for new apps; this script only backfills existing ones.

DO $migrate$
DECLARE
  r record;
  s text;      -- quoted schema ident, e.g. "app_myslug"
  role_ident text;
BEGIN
  FOR r IN
    SELECT schema_name
      FROM information_schema.schemata
     WHERE schema_name LIKE 'app\_%'
       -- only schemas that already have the per-user kv table (a real app schema)
       AND EXISTS (
         SELECT 1 FROM information_schema.tables t
          WHERE t.table_schema = schemata.schema_name AND t.table_name = 'kv'
       )
  LOOP
    s := quote_ident(r.schema_name);
    role_ident := quote_ident(r.schema_name || '_role');

    EXECUTE format($ddl$
      CREATE TABLE IF NOT EXISTS %s.shared_kv (
        key text PRIMARY KEY,
        author_user_id integer NOT NULL,
        value jsonb NOT NULL,
        size_bytes integer GENERATED ALWAYS AS (octet_length(value::text)) STORED,
        hidden_at timestamptz,
        hidden_by integer,
        created_at timestamptz DEFAULT now() NOT NULL,
        updated_at timestamptz DEFAULT now() NOT NULL
      )$ddl$, s);

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS shared_kv_author_idx ON %s.shared_kv (author_user_id)', s);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS shared_kv_created_idx ON %s.shared_kv (created_at)', s);

    EXECUTE format($ddl$
      CREATE TABLE IF NOT EXISTS %s.votes (
        key text NOT NULL REFERENCES %s.shared_kv(key) ON DELETE CASCADE,
        user_id integer NOT NULL,
        created_at timestamptz DEFAULT now() NOT NULL,
        PRIMARY KEY (key, user_id)
      )$ddl$, s, s);

    EXECUTE format($ddl$
      CREATE TABLE IF NOT EXISTS %s.counters (
        key text PRIMARY KEY REFERENCES %s.shared_kv(key) ON DELETE CASCADE,
        count bigint NOT NULL DEFAULT 0 CHECK (count >= 0)
      )$ddl$, s, s);

    EXECUTE format($ddl$
      CREATE TABLE IF NOT EXISTS %s.shared_kv_reports (
        id text PRIMARY KEY,
        key text,
        reporter_user_id integer,
        reason text,
        created_at timestamptz DEFAULT now() NOT NULL
      )$ddl$, s);

    -- Reuse the existing per-schema kv_quota_trigger() on shared_kv so shared
    -- bytes/rows fold into the same app quota row (created with the schema).
    EXECUTE format('DROP TRIGGER IF EXISTS shared_kv_quota_trg ON %s.shared_kv', s);
    EXECUTE format($ddl$
      CREATE TRIGGER shared_kv_quota_trg
      AFTER INSERT OR UPDATE OR DELETE ON %s.shared_kv
      FOR EACH ROW EXECUTE FUNCTION %s.kv_quota_trigger()$ddl$, s, s);

    -- Re-grant on the new tables to the per-app NOLOGIN role (ALTER DEFAULT
    -- PRIVILEGES already covers future tables, but a re-grant is safe + covers
    -- schemas whose defaults predate the shared tables).
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %s TO %s',
      s, role_ident);
  END LOOP;
END
$migrate$;
