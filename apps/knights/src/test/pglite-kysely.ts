import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

const MIGRATION = fileURLToPath(
  new URL(
    '../../../../packages/civitai-db-schema/prisma/migrations/20261210120000_knights_v2_queue/migration.sql',
    import.meta.url
  )
);

// Cut to the columns the queue reads; the real tables live in the main schema.
const STAND_INS = `
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "url" TEXT NOT NULL,
  "width" INTEGER,
  "height" INTEGER,
  "type" TEXT NOT NULL DEFAULT 'image',
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE "NewOrderPlayer" (
  "userId" INTEGER PRIMARY KEY,
  "rankType" TEXT NOT NULL,
  "exp" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE "NewOrderSmite" (
  "id" SERIAL PRIMARY KEY,
  "targetPlayerId" INTEGER NOT NULL,
  "cleansedAt" TIMESTAMP(3)
);
`;

function dialect(pg: PGlite): Dialect {
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const result = await pg.query(compiled.sql, compiled.parameters as unknown[]);
      return { rows: result.rows as R[], numAffectedRows: BigInt(result.affectedRows ?? 0) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('streaming is not used by the queue');
    },
  };
  const noop = async () => undefined;
  const driver: Driver = {
    init: noop,
    acquireConnection: async () => connection,
    beginTransaction: async (conn) => void (await conn.executeQuery(CompiledQuery.raw('begin'))),
    commitTransaction: async (conn) => void (await conn.executeQuery(CompiledQuery.raw('commit'))),
    rollbackTransaction: async (conn) =>
      void (await conn.executeQuery(CompiledQuery.raw('rollback'))),
    releaseConnection: noop,
    destroy: noop,
  };
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => driver,
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}

/** A real in-process Postgres with the committed migration applied over stand-in main tables. */
export async function createQueueDb(): Promise<{ pg: PGlite; db: Kysely<DB> }> {
  const pg = await PGlite.create();
  await pg.exec(STAND_INS);
  await pg.exec(readFileSync(MIGRATION, 'utf8'));
  return { pg, db: new Kysely<DB>({ dialect: dialect(pg) }) };
}
