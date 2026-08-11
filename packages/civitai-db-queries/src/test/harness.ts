import { type CompiledQuery, CompiledQuery as CompiledQueryClass } from 'kysely';
import { createKyselyClients } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { compileHarness } from './compile-harness';

// `compileHarness` lives in its own module and is re-exported here for the package's own tests,
// which import it from `./test/harness` alongside the DB-backed helpers. Only that module — NOT
// this one — is on the package's public `./test-harness` subpath: everything below resolves a
// connection string and can fall back to `process.env.DATABASE_URL`, so it must stay
// package-internal. See the note at the top of `compile-harness.ts`.
export { compileHarness };

// The DB URL for the DB-backed tier. Prefer a dedicated TEST_DATABASE_URL; fall back to DATABASE_URL for local
// runs. Absent (e.g. plain CI with no Postgres) → the DB-backed suites skip via `describe.skipIf`.
export function testDbUrl(): string | undefined {
  return process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
}

// The DB-backed tier. `db` is still the DummyDriver client (so passing it to a query function COMPILES without
// executing — this never runs a write against the DB). A separate real client is used ONLY to `EXPLAIN` a
// captured compiled query: `EXPLAIN` (no ANALYZE) parses + plans the statement against the live schema without
// executing it, validating that a ported query's columns/joins/types resolve — safely, for reads and writes.
export function explainHarness() {
  const compile = compileHarness();
  const url = testDbUrl();
  const realDb = url
    ? createKyselyClients<DB>({ connectionString: url, singleClient: true, sslNoVerify: true }).db
    : null;

  async function explain(cq: CompiledQuery): Promise<string> {
    if (!realDb)
      throw new Error('explainHarness: no DB URL (set TEST_DATABASE_URL or DATABASE_URL)');
    return realDb.connection().execute(async (conn) => {
      const result = await conn.executeQuery<Record<string, string>>(
        CompiledQueryClass.raw(`explain ${cq.sql}`, [...cq.parameters])
      );
      return result.rows.map((row) => row['QUERY PLAN']).join('\n');
    });
  }

  return {
    db: compile.db,
    lastQuery: compile.lastQuery,
    queries: compile.queries,
    hasDb: !!realDb,
    // EXPLAIN the last compiled query; returns the plan text.
    explainLast: () => explain(compile.lastQuery()),
    // EXPLAIN every compiled query captured so far (a function may issue several); returns plans in order.
    explainAll: () => Promise.all(compile.queries.map(explain)),
    destroy: () => realDb?.destroy() ?? Promise.resolve(),
  };
}
