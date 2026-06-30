import { Kysely, PostgresDialect } from 'kysely';
import { Pool, type PoolConfig } from 'pg';

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
}

export function createKyselyClients<DB>(
  options: CreateKyselyClientsOptions & { singleClient: true }
): { db: Kysely<DB> };
export function createKyselyClients<DB>(options?: CreateKyselyClientsOptions): KyselyReadWrite<DB>;
export function createKyselyClients<DB>(
  options: CreateKyselyClientsOptions = {}
): { db: Kysely<DB> } | KyselyReadWrite<DB> {
  const { pool, readPool, replicaConnectionString, singleClient, ...poolConfig } = options;
  const make = (p: Pool) => new Kysely<DB>({ dialect: new PostgresDialect({ pool: p }) });

  const primary = make(pool ?? new Pool(poolConfig));
  if (singleClient) return { db: primary };

  const dbRead =
    readPool || replicaConnectionString
      ? make(readPool ?? new Pool({ ...poolConfig, connectionString: replicaConnectionString }))
      : primary;
  return { dbRead, dbWrite: primary };
}
