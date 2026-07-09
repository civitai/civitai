import { Kysely, PostgresDialect } from 'kysely';
import { Pool, types, type PoolConfig } from 'pg';

// Re-export `sql` so apps build raw fragments without a direct kysely dependency — the db layer owns it.
export { sql } from 'kysely';
export type { RawBuilder } from 'kysely';

// Kysely client builder. Standalone — imports only kysely + pg (NOT the Prisma client /
// db-helpers / env), so a Vite/SSR app can import `@civitai/db/kysely` without pulling Prisma.
//
// Return shape follows intent:
//   singleClient: true        -> { db }                 (single-DB apps, e.g. the auth hub)
//   otherwise                 -> { dbRead, dbWrite }    (the createPrismaClients analogue)
//
// Connection config is EXPLICIT (no env coupling): pass a connectionString, or pre-built pools.
// For replica routing in the main app, hand it getClient() pools at the call site:
//   createKyselyClients<DB>({ pool: getClient({ instance: 'primary' }),
//                             readPool: getClient({ instance: 'primaryRead' }) })

// pg returns NUMERIC/INT8 as strings by default (to preserve precision); for Kysely query results we
// want JS numbers. setTypeParser mutates pg's PROCESS-GLOBAL parser registry, so we register lazily
// from inside the factory (not at module load) — a Prisma-only consumer that merely imports
// `@civitai/db` (which re-exports this module) must not have its global pg parsing flipped without
// asking. Only callers that actually build a Kysely client opt in. Idempotent.
let numericParsersRegistered = false;
function registerNumericTypeParsers() {
  if (numericParsersRegistered) return;
  types.setTypeParser(types.builtins.NUMERIC, (val) => parseFloat(val));
  types.setTypeParser(types.builtins.INT8, (val) => parseFloat(val));
  numericParsersRegistered = true;
}

// Force `sslmode=no-verify` on a connection string: keep SSL on, skip chain verification. node-postgres
// maps a URL's `sslmode=require` to FULL verification (unlike libpq), which rejects the cnpg pooler's
// self-signed cert — and a separate `ssl` option is overridden by the URL's sslmode. Centralized here so
// every spoke app stops re-deriving it. Mirrors the main app's db-helpers.
function forceSslNoVerify(connectionString?: string): string | undefined {
  if (!connectionString) return connectionString;
  const url = new URL(connectionString);
  url.searchParams.set('sslmode', 'no-verify');
  return url.toString();
}

export type KyselyReadWrite<DB> = { dbRead: Kysely<DB>; dbWrite: Kysely<DB> };

export interface CreateKyselyClientsOptions extends PoolConfig {
  /** Pre-built write pool (primary). Overrides connectionString. */
  pool?: Pool;
  /** Pre-built read pool (replica). Defaults to the write pool. */
  readPool?: Pool;
  /** Connection string for a read replica, to derive a second pool. */
  replicaConnectionString?: string;
  /** Collapse to a single `{ db }` — no replica, or read-your-writes flows. */
  singleClient?: boolean;
  /**
   * Force `sslmode=no-verify` on the derived connection strings (SSL on, verification off) — for the
   * cnpg pooler's self-signed cert. Applies to `connectionString` and `replicaConnectionString`;
   * pre-built pools are passed through untouched (configure SSL where you build them).
   */
  sslNoVerify?: boolean;
}

export function createKyselyClients<DB>(
  options: CreateKyselyClientsOptions & { singleClient: true }
): { db: Kysely<DB> };
export function createKyselyClients<DB>(options?: CreateKyselyClientsOptions): KyselyReadWrite<DB>;
export function createKyselyClients<DB>(
  options: CreateKyselyClientsOptions = {}
): { db: Kysely<DB> } | KyselyReadWrite<DB> {
  registerNumericTypeParsers();

  const { pool, readPool, replicaConnectionString, singleClient, sslNoVerify, ...poolConfig } =
    options;
  if (sslNoVerify && poolConfig.connectionString) {
    poolConfig.connectionString = forceSslNoVerify(poolConfig.connectionString);
  }
  const replicaString = sslNoVerify ? forceSslNoVerify(replicaConnectionString) : replicaConnectionString;

  const make = (p: Pool) => new Kysely<DB>({ dialect: new PostgresDialect({ pool: p }) });

  const primary = make(pool ?? new Pool(poolConfig));
  if (singleClient) return { db: primary };

  const dbRead =
    readPool || replicaString
      ? make(readPool ?? new Pool({ ...poolConfig, connectionString: replicaString }))
      : primary;
  return { dbRead, dbWrite: primary };
}
