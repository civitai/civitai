import type { PGlite } from '@electric-sql/pglite';
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

/**
 * A Kysely client over an in-memory PGlite, for running the app's Kysely SQL against real tables.
 * `getPg` is read on every query, so a module mock can be built before the test creates its PGlite.
 * No transactions: each statement runs on its own.
 */
export function pgliteKysely(getPg: () => PGlite): Kysely<DB> {
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const result = await getPg().query(compiled.sql, [...compiled.parameters]);
      return { rows: result.rows as R[], numAffectedRows: BigInt(result.affectedRows ?? 0) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('streaming is not used');
    },
  };
  const dialect: Dialect = {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => ({
      init: async () => undefined,
      acquireConnection: async () => connection,
      beginTransaction: async () => undefined,
      commitTransaction: async () => undefined,
      rollbackTransaction: async () => undefined,
      releaseConnection: async () => undefined,
      destroy: async () => undefined,
    }),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
  return new Kysely<DB>({ dialect });
}
