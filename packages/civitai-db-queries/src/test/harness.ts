import {
  type CompiledQuery,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  CompiledQuery as CompiledQueryClass,
} from 'kysely';
import { createKyselyClients } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { UPDATED_AT_TABLES } from '@civitai/db-schema/kysely/updated-at-tables';
import { updatedAtPlugin } from '../infra/updated-at-plugin';

// Query functions take a Kysely client as their first argument (executor injection). These harnesses build
// the client a test passes in — no global wiring.

// An offline Kysely wired to DummyDriver: pass its `db` to a query function and the function's SQL COMPILES to
// real Postgres SQL and `.execute()` resolves to an empty result WITHOUT a database (safe for writes). A `log`
// hook captures each compiled query so a test can assert the exact SQL + parameters.
//
// The `@updatedAt` plugin is installed here exactly as the app installs it (kyselyDb.ts), so the compiled SQL a
// test sees matches production: an UPDATE to an `@updatedAt` table auto-stamps `updatedAt` unless the write
// opts out (self-reference `keepUpdatedAt`) or is raw `sql`. Ported writes therefore don't set `updatedAt` by
// hand, and the tests assert the plugin-stamped result.
export function compileHarness() {
  const queries: CompiledQuery[] = [];

  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [updatedAtPlugin(UPDATED_AT_TABLES)],
    log: (event) => {
      if (event.level === 'query') queries.push(event.query);
    },
  });

  return {
    db,
    // The most recently compiled query — `{ sql, parameters }`.
    lastQuery: () => queries[queries.length - 1],
    queries,
  };
}

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
