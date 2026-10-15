// Test harnesses for the document store: an in-process PGlite (always available)
// and a real Postgres server (when APPDATA_TEST_DATABASE_URL names one). Both
// apply the REAL migration file, unmodified, and the store always connects as
// the migration's `appdata_rw` role (it refuses a superuser). The PGlite harness
// can additionally DISABLE row-level security on the tables after migrating, so
// a suite exercises the module's own predicates alone.
import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { Client } from 'pg';
import type { DocStoreClient, DocStoreDb } from '~/server/services/apps/doc-store';
import {
  APPDATA_TABLES,
  isAccountWipeStatement,
  isReviewMaintenanceStatement,
  scanStatement,
} from './doc-store.sql-scan';

export const MIGRATION_UP = path.resolve(
  __dirname,
  '../migrations/20261013120000_appdata_document_store.sql'
);
export const MIGRATION_DOWN = path.resolve(
  __dirname,
  '../migrations/20261013120000_appdata_document_store.down.sql'
);

export type Row = Record<string, unknown>;

export type StatementRecord = { sql: string; params: unknown[]; app: string; ns: string };

export type Harness = {
  label: string;
  /** Whether row-level security is enabled on the tables (store connections are always `appdata_rw`). */
  rls: boolean;
  concurrent: boolean;
  db: DocStoreDb;
  /** Superuser query, RLS bypassed — for seeding and asserting. */
  raw(sql: string, params?: unknown[]): Promise<Row[]>;
  /** A store connection as an arbitrary role (null = the superuser) — for the role check. */
  dbAs(role: string | null): DocStoreDb;
  /** A connection as `appdata_rw` with no store involvement — for RLS probes. */
  rawAsRole(): Promise<{
    query(sql: string, params?: unknown[]): Promise<Row[]>;
    close(): Promise<void>;
  }>;
  /** Every statement the store sent, with the app/ns its transaction was bound to. */
  statements: StatementRecord[];
  /** Isolation-shape violations seen at runtime (statement text + params). */
  violations: string[];
  close(): Promise<void>;
};

const BEGIN_SETTINGS =
  /^BEGIN; SELECT set_config\('appdata\.app_id', '([^']*)', true\), set_config\('appdata\.ns', '([^']*)', true\), set_config\('lock_timeout', '[0-9]+s', true\)$/;
/** The store's review-maintenance transaction: no namespace, maintenance on, app id or none. */
const BEGIN_MAINTENANCE =
  /^BEGIN; SELECT set_config\('appdata\.app_id', '([^']*)', true\), set_config\('appdata\.ns', '', true\), set_config\('appdata\.review_maintenance', 'on', true\), set_config\('lock_timeout', '[0-9]+s', true\)$/;
/** The store's account-wipe enumeration transaction: no app or namespace, one user id. */
const BEGIN_ACCOUNT_WIPE =
  /^BEGIN; SELECT set_config\('appdata\.app_id', '', true\), set_config\('appdata\.ns', '', true\), set_config\('appdata\.account_wipe_uid', '([1-9][0-9]*)', true\), set_config\('lock_timeout', '[0-9]+s', true\)$/;

/**
 * Wrap a store client so every statement is recorded and checked: the settings
 * bound by BEGIN are remembered, and each later statement touching an appdata
 * table must pass the static shape scan AND carry exactly those values as $1/$2.
 * This is the runtime half of the isolation guard — it sees the SQL the list
 * builder assembles, which no static scan can.
 */
function recording(inner: DocStoreClient, h: Pick<Harness, 'statements' | 'violations'>) {
  let bound: {
    app: string;
    ns: string;
    maintenance: boolean;
    /** The user id an account-wipe enumeration transaction is bound to. */
    wipeUid?: number;
  } | null = null;
  const client: DocStoreClient = {
    async query(sql, params) {
      const m = BEGIN_SETTINGS.exec(sql);
      const mm = BEGIN_MAINTENANCE.exec(sql);
      const mw = BEGIN_ACCOUNT_WIPE.exec(sql);
      if (m) bound = { app: m[1], ns: m[2], maintenance: false };
      else if (mm) bound = { app: mm[1], ns: '', maintenance: true };
      else if (mw) bound = { app: '', ns: '', maintenance: false, wipeUid: Number(mw[1]) };
      else if (sql === 'COMMIT' || sql === 'ROLLBACK') bound = null;
      else if (/appdata/i.test(sql)) {
        const p = params ?? [];
        if (!bound) h.violations.push(`statement outside a bound transaction: ${sql}`);
        else if (isAccountWipeStatement(sql) || bound.wipeUid !== undefined) {
          h.statements.push({ sql, params: p, app: bound.app, ns: bound.ns });
          // The enumeration runs only in its own transaction, keyed on the bound user as $1.
          if (bound.wipeUid === undefined || !isAccountWipeStatement(sql)) {
            h.violations.push(
              `account-wipe statement outside its transaction, or vice versa: ${sql}`
            );
          } else if (p[0] !== bound.wipeUid) {
            h.violations.push(`$1 does not match the bound account-wipe user: ${sql}`);
          }
        } else {
          h.statements.push({ sql, params: p, app: bound.app, ns: bound.ns });
          const maintenanceShape = isReviewMaintenanceStatement(sql);
          if (maintenanceShape !== bound.maintenance) {
            h.violations.push(
              `${
                maintenanceShape ? 'maintenance statement outside' : 'scoped statement inside'
              } a maintenance transaction: ${sql}`
            );
          } else if (bound.maintenance) {
            // A purge carries the request as $1; the listing binds no app and carries none.
            if (bound.app !== '' && p[0] !== bound.app) {
              h.violations.push(`$1 does not match the bound request: ${sql}`);
            }
            if (bound.app === '' && /app_id\s*=\s*\$1/.test(sql)) {
              h.violations.push(`keyed maintenance statement with no bound request: ${sql}`);
            }
          } else if (p[0] !== bound.app || p[1] !== bound.ns) {
            h.violations.push(`$1/$2 do not match the bound context: ${sql}`);
          }
        }
        for (const v of scanStatement(sql)) h.violations.push(`${v}: ${sql}`);
      }
      return inner.query(sql, params);
    },
    release: (err) => inner.release(err),
  };
  return client;
}

// ---------------------------------------------------------------------------
// PGlite — one session, so the store must be driven sequentially.
// ---------------------------------------------------------------------------

export async function createPgliteHarness(opts: { rls: boolean }): Promise<Harness> {
  const pg = new PGlite();
  await pg.exec(readFileSync(MIGRATION_UP, 'utf8'));
  if (!opts.rls) {
    for (const t of APPDATA_TABLES) {
      await pg.exec(`ALTER TABLE appdata.${t} DISABLE ROW LEVEL SECURITY`);
    }
  }

  async function run(sql: string, params?: unknown[]): Promise<Row[]> {
    if (params && params.length > 0) return (await pg.query<Row>(sql, params)).rows;
    const results = await pg.exec(sql);
    return (results[results.length - 1]?.rows ?? []) as Row[];
  }

  function dbAs(role: string | null): DocStoreDb {
    return {
      async connect() {
        await pg.exec(role ? `SET ROLE ${role}` : 'RESET ROLE');
        const inner: DocStoreClient = {
          async query(sql, params) {
            const rows = await run(sql, params);
            return { rows, rowCount: rows.length };
          },
          release() {
            void pg.exec('RESET ROLE');
          },
        };
        return recording(inner, h);
      },
    };
  }

  const h: Harness = {
    label: `pglite (appdata_rw, RLS ${opts.rls ? 'on' : 'disabled'})`,
    rls: opts.rls,
    concurrent: false,
    statements: [],
    violations: [],
    db: dbAs('appdata_rw'),
    dbAs,
    async raw(sql, params) {
      await pg.exec('RESET ROLE');
      return run(sql, params);
    },
    async rawAsRole() {
      await pg.exec('SET ROLE appdata_rw');
      return {
        query: run,
        close: async () => {
          await pg.exec('RESET ROLE');
        },
      };
    },
    async close() {
      await pg.close();
    },
  };
  return h;
}

// ---------------------------------------------------------------------------
// Real Postgres — one connection per store checkout, so writers really race.
// ---------------------------------------------------------------------------

export const REAL_PG_URL = process.env.APPDATA_TEST_DATABASE_URL;

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/** Real Postgres, RLS on, store connections as `appdata_rw`. */
export async function createRealPgHarness(): Promise<Harness> {
  if (!REAL_PG_URL) throw new Error('APPDATA_TEST_DATABASE_URL is not set');
  const dbName = `appdata_t_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new Client({ connectionString: REAL_PG_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const dbUrl = withDatabase(REAL_PG_URL, dbName);
  const su = new Client({ connectionString: dbUrl });
  await su.connect();
  await su.query(readFileSync(MIGRATION_UP, 'utf8'));
  const open = new Set<Client>();

  async function newClient(role: string | null): Promise<Client> {
    const c = new Client({ connectionString: dbUrl });
    await c.connect();
    if (role) await c.query(`SET ROLE ${role}`);
    open.add(c);
    return c;
  }

  function dbAs(role: string | null): DocStoreDb {
    return {
      async connect() {
        const c = await newClient(role);
        const inner: DocStoreClient = {
          async query(sql, params) {
            const r = await c.query(sql, params as unknown[]);
            // A multi-statement simple query returns an array of results.
            const last = Array.isArray(r) ? r[r.length - 1] : r;
            return { rows: last.rows as Row[], rowCount: last.rowCount };
          },
          release() {
            open.delete(c);
            void c.end();
          },
        };
        return recording(inner, h);
      },
    };
  }

  const h: Harness = {
    label: 'postgres (appdata_rw, RLS on)',
    rls: true,
    concurrent: true,
    statements: [],
    violations: [],
    db: dbAs('appdata_rw'),
    dbAs,
    async raw(sql, params) {
      return (await su.query(sql, params)).rows as Row[];
    },
    async rawAsRole() {
      const c = await newClient('appdata_rw');
      return {
        query: async (sql: string, params?: unknown[]) =>
          (await c.query(sql, params)).rows as Row[],
        close: async () => {
          open.delete(c);
          await c.end();
        },
      };
    },
    async close() {
      await Promise.all([...open].map((c) => c.end().catch(() => undefined)));
      await su.end();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    },
  };
  return h;
}

/** A promise barrier: `wait()` resolves once `n` callers are waiting, or after `timeoutMs`. */
export function barrier(n: number, timeoutMs = 10_000) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const timer = setTimeout(() => release(), timeoutMs);
  return {
    get arrived() {
      return arrived;
    },
    async wait() {
      arrived += 1;
      if (arrived >= n) {
        clearTimeout(timer);
        release();
      }
      await gate;
    },
  };
}
