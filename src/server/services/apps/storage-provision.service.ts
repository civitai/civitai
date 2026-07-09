// App Blocks KV datastore provisioning (W4-KV-v0).
//
// Each approved app block gets:
//   - schema `app_<slug>`
//   - table `app_<slug>.kv` (block_instance_id, user_id, key, value jsonb, sizes, timestamps)
//   - table `app_<slug>.quota` (app_block_id, used_bytes, row_count)
//   - trigger function + trigger on kv to keep quota in sync
//   - dedicated role `app_<slug>_role` (NOLOGIN) with schema-scoped grants
//
// Idempotency: every DDL statement uses IF NOT EXISTS, the role creation
// uses a DO block, and the quota seed row uses ON CONFLICT DO NOTHING. The
// W2 webhook handler calls provision() on every approved version push; the
// backfill job (P7) calls it on every approved app_block row. Either path
// is safe to repeat.
//
// Slug safety: slugs are validated through `isValidAppSlug` before any DDL
// touches them. Identifiers can't be parameterized via $1 in Postgres, so
// the regex (`^[a-z][a-z0-9_]{2,40}$`) is the load-bearing safety boundary.

import { requireAppsDb } from '~/server/db/appsDb';
import {
  appRoleIdent,
  appSchemaIdent,
  isValidAppSlug,
} from '~/server/utils/apps-slug';

export type ProvisionOpts = {
  appBlockId: string;
  slug: string;
};

export const AppStorageProvisioner = {
  /**
   * Idempotent. Creates schema + tables + role + quota seed for an app block.
   * Called from W2-v0's webhook handler after manifest validation lands +
   * before flipping `app_blocks.status` to 'approved', and from the
   * backfill job that ensures every approved app has a schema.
   */
  async provision({ appBlockId, slug }: ProvisionOpts): Promise<void> {
    if (!isValidAppSlug(slug)) {
      throw new Error(`AppStorageProvisioner.provision: invalid slug ${JSON.stringify(slug)}`);
    }
    if (typeof appBlockId !== 'string' || appBlockId.length === 0) {
      throw new Error(`AppStorageProvisioner.provision: appBlockId required`);
    }

    const schema = appSchemaIdent(slug); // "app_<slug>"
    const role = appRoleIdent(slug);     // "app_<slug>_role"

    const pool = requireAppsDb();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.kv (
          block_instance_id text NOT NULL,
          user_id integer NOT NULL,
          key text NOT NULL,
          value jsonb NOT NULL,
          size_bytes integer GENERATED ALWAYS AS (octet_length(value::text)) STORED,
          created_at timestamptz DEFAULT now() NOT NULL,
          updated_at timestamptz DEFAULT now() NOT NULL,
          PRIMARY KEY (block_instance_id, user_id, key)
        )
      `);

      await client.query(
        `CREATE INDEX IF NOT EXISTS kv_user_idx ON ${schema}.kv (user_id, block_instance_id)`
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS kv_updated_idx ON ${schema}.kv (updated_at)`
      );

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.quota (
          app_block_id text PRIMARY KEY,
          used_bytes bigint NOT NULL DEFAULT 0,
          row_count bigint NOT NULL DEFAULT 0,
          updated_at timestamptz DEFAULT now() NOT NULL
        )
      `);

      // ── SHARED (app-global / cross-user) storage tables ────────────────────
      // The public-write surface (voting + community lists). Distinct from the
      // per-user `kv` table above: rows are app-global, readable by all users of
      // the app, written per the shared write policy (apps-shared.router).
      //
      // shared_kv.key is a SERVER-generated ULID (never a client key — C1: a
      // client-chosen key would let user B overwrite user A's row). INSERT-only
      // create; author_user_id is attribution + rate-limit + moderation.
      // size_bytes mirrors `kv` so the SAME quota trigger folds shared bytes/rows
      // into the app's 50MB / 1M budget. hidden_at/hidden_by back the mod soft-hide.
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.shared_kv (
          key text PRIMARY KEY,
          author_user_id integer NOT NULL,
          value jsonb NOT NULL,
          size_bytes integer GENERATED ALWAYS AS (octet_length(value::text)) STORED,
          hidden_at timestamptz,
          hidden_by integer,
          created_at timestamptz DEFAULT now() NOT NULL,
          updated_at timestamptz DEFAULT now() NOT NULL
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS shared_kv_author_idx ON ${schema}.shared_kv (author_user_id)`
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS shared_kv_created_idx ON ${schema}.shared_kv (created_at)`
      );

      // votes — one row per (key, user). The UNIQUE (composite PK) guarantees
      // one-vote-per-user (H1). FK ON DELETE CASCADE ties a vote's lifetime to its
      // request so withdraw/purge reclaim cleanly. This table is NEVER listable —
      // only the aggregate `count` is ever returned (design isolation invariant).
      // votes carry NO size_bytes / NO quota trigger → excluded from the byte quota.
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.votes (
          key text NOT NULL REFERENCES ${schema}.shared_kv(key) ON DELETE CASCADE,
          user_id integer NOT NULL,
          created_at timestamptz DEFAULT now() NOT NULL,
          PRIMARY KEY (key, user_id)
        )
      `);

      // counters — the monotonic vote-tally CACHE (votes are the source of truth,
      // this is reconstructable). CHECK(count >= 0) blocks any unvote underflow
      // (H1). FK ON DELETE CASCADE. Excluded from the byte quota.
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.counters (
          key text PRIMARY KEY REFERENCES ${schema}.shared_kv(key) ON DELETE CASCADE,
          count bigint NOT NULL DEFAULT 0 CHECK (count >= 0)
        )
      `);

      // shared_kv_reports — user + moderator reports on a shared row (M4/M5). The
      // `key` is intentionally NOT an FK: a report must survive a hard-delete/purge
      // of the row it concerns (audit trail). Excluded from the byte quota.
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.shared_kv_reports (
          id text PRIMARY KEY,
          key text,
          reporter_user_id integer,
          reason text,
          created_at timestamptz DEFAULT now() NOT NULL
        )
      `);

      // Trigger function — quota row is keyed on app_block_id pulled from
      // session-local `app.current_app_block_id`. tRPC procedures must
      // `SET LOCAL app.current_app_block_id = ...` in the same txn as the
      // INSERT/UPDATE/DELETE that fires this trigger; if the GUC is unset,
      // current_setting('app.current_app_block_id', true) returns null and
      // the UPDATE no-ops (we accept slight quota drift over a hard failure
      // on the user write path — the periodic recompute in P7 reconciles).
      await client.query(`
        CREATE OR REPLACE FUNCTION ${schema}.kv_quota_trigger() RETURNS trigger AS $fn$
        DECLARE
          v_app_block_id text := current_setting('app.current_app_block_id', true);
        BEGIN
          IF v_app_block_id IS NULL OR v_app_block_id = '' THEN
            RETURN NULL;
          END IF;
          IF TG_OP = 'INSERT' THEN
            UPDATE ${schema}.quota
               SET used_bytes = used_bytes + NEW.size_bytes,
                   row_count  = row_count + 1,
                   updated_at = now()
             WHERE app_block_id = v_app_block_id;
          ELSIF TG_OP = 'UPDATE' THEN
            UPDATE ${schema}.quota
               SET used_bytes = used_bytes + (NEW.size_bytes - OLD.size_bytes),
                   updated_at = now()
             WHERE app_block_id = v_app_block_id;
          ELSIF TG_OP = 'DELETE' THEN
            UPDATE ${schema}.quota
               SET used_bytes = used_bytes - OLD.size_bytes,
                   row_count  = row_count - 1,
                   updated_at = now()
             WHERE app_block_id = v_app_block_id;
          END IF;
          RETURN NULL;
        END $fn$ LANGUAGE plpgsql
      `);

      // Drop+recreate the trigger so changes to the function body land
      // without orphaning an old binding. The function body is immutable
      // text per schema so this is a no-op for already-provisioned apps.
      await client.query(`DROP TRIGGER IF EXISTS kv_quota_trg ON ${schema}.kv`);
      await client.query(`
        CREATE TRIGGER kv_quota_trg
        AFTER INSERT OR UPDATE OR DELETE ON ${schema}.kv
        FOR EACH ROW EXECUTE FUNCTION ${schema}.kv_quota_trigger()
      `);

      // Reuse the SAME quota-trigger function on shared_kv (it only touches
      // ${schema}.quota + NEW/OLD.size_bytes + row_count — all present on
      // shared_kv). Shared writes SET LOCAL app.current_app_block_id in-txn just
      // like the per-user path, so shared bytes/rows fold into the same 50MB / 1M
      // app budget. votes/counters/reports have no trigger → excluded from quota.
      await client.query(`DROP TRIGGER IF EXISTS shared_kv_quota_trg ON ${schema}.shared_kv`);
      await client.query(`
        CREATE TRIGGER shared_kv_quota_trg
        AFTER INSERT OR UPDATE OR DELETE ON ${schema}.shared_kv
        FOR EACH ROW EXECUTE FUNCTION ${schema}.kv_quota_trigger()
      `);

      // Per-app role — IF NOT EXISTS exists for CREATE ROLE only on PG 15+
      // CNPG image; we use the DO block guard for portability.
      await client.query(`
        DO $do$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(`app_${slug}_role`)}) THEN
            CREATE ROLE ${role} NOLOGIN;
          END IF;
        END $do$
      `);
      await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`
      );
      await client.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);

      // Future tables in this schema (none today, but v1 SQL upgrade will
      // add them) auto-inherit the same grants.
      await client.query(`
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}
      `);
      await client.query(`
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
          GRANT USAGE ON SEQUENCES TO ${role}
      `);

      await client.query(
        `INSERT INTO ${schema}.quota (app_block_id) VALUES ($1) ON CONFLICT (app_block_id) DO NOTHING`,
        [appBlockId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Drop schema + role entirely. Called when an app block is permanently
   * deleted (NOT when deactivated — deactivated apps keep their schema in
   * case they are reactivated). CASCADE drops every table the schema
   * contains, including their grant references on the per-app role, so
   * `DROP ROLE` after the CASCADE is safe.
   */
  async deprovision({ slug }: { slug: string }): Promise<void> {
    if (!isValidAppSlug(slug)) {
      throw new Error(`AppStorageProvisioner.deprovision: invalid slug ${JSON.stringify(slug)}`);
    }
    const schema = appSchemaIdent(slug);
    const role = appRoleIdent(slug);

    const pool = requireAppsDb();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.query(`
        DO $do$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(`app_${slug}_role`)}) THEN
            DROP ROLE ${role};
          END IF;
        END $do$
      `);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Look up the live used_bytes + row_count for an app. Returns null when
   * the schema hasn't been provisioned yet (caller usually treats that as
   * "0 bytes, 0 rows" + a provision-on-demand follow-up).
   */
  async getQuota({
    appBlockId,
    slug,
  }: ProvisionOpts): Promise<{ usedBytes: number; rowCount: number } | null> {
    if (!isValidAppSlug(slug)) {
      throw new Error(`AppStorageProvisioner.getQuota: invalid slug ${JSON.stringify(slug)}`);
    }
    const schema = appSchemaIdent(slug);
    const pool = requireAppsDb();
    // information_schema lookup avoids a relation-doesn't-exist error
    // when an unprovisioned slug slips through.
    const schemaExists = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS exists`,
      [`app_${slug}`]
    );
    if (!schemaExists.rows[0]?.exists) return null;

    const result = await pool.query<{ used_bytes: string; row_count: string }>(
      `SELECT used_bytes::text, row_count::text FROM ${schema}.quota WHERE app_block_id = $1`,
      [appBlockId]
    );
    if (result.rows.length === 0) return { usedBytes: 0, rowCount: 0 };
    return {
      usedBytes: Number(result.rows[0].used_bytes ?? '0'),
      rowCount: Number(result.rows[0].row_count ?? '0'),
    };
  },
};

// Safe SQL literal for identifiers we still need to compare via text (e.g.
// `pg_roles.rolname = '...'`). Doubles single quotes; the slug regex
// prevents any other escape chars from reaching here, but this keeps the
// quoting defensible if the caller's contract slips.
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
