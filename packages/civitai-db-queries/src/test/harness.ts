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
import { connect } from '../infra/client';

// An offline Kysely wired to DummyDriver: query builders compile to real Postgres SQL and `.execute()`
// resolves to an empty result set WITHOUT a database. A `log` hook captures each compiled query so a test
// can assert the exact SQL + parameters a query function produces — enough to catch a refactor that drops a
// filter, reorders a `set` clause, or would emit `IN ()`.
export function connectCompileOnly() {
  const queries: CompiledQuery[] = [];

  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') queries.push(event.query);
    },
  });

  connect({ read: db, write: db });

  return {
    // The most recently executed compiled query — `{ sql, parameters }`.
    lastQuery: () => queries[queries.length - 1],
    queries,
  };
}

// The DB URL for the DB-backed tier. Prefer a dedicated TEST_DATABASE_URL; fall back to DATABASE_URL for
// local runs. Absent (e.g. plain CI with no Postgres) → the DB-backed suites skip via `describe.skipIf`.
export function testDbUrl(): string | undefined {
  return process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
}

// The DB-backed tier. It keeps the DummyDriver connected (so the query functions still COMPILE without
// executing — critical: this never runs a write against the DB), and separately holds a real Kysely client
// used ONLY to `EXPLAIN` a captured compiled query. `EXPLAIN` (no ANALYZE) parses + plans the statement
// against the live schema without executing it, so it validates that a ported query's columns/joins/types
// resolve against the real database AND exposes the plan for seq-scan / index-usage assertions — safely,
// for reads and writes alike.
export function connectWithExplain() {
  const compile = connectCompileOnly();
  const url = testDbUrl();
  const realDb = url
    ? createKyselyClients<DB>({ connectionString: url, singleClient: true, sslNoVerify: true }).db
    : null;

  async function explain(cq: CompiledQuery): Promise<string> {
    if (!realDb) throw new Error('connectWithExplain: no DB URL (set TEST_DATABASE_URL or DATABASE_URL)');
    return realDb.connection().execute(async (conn) => {
      const result = await conn.executeQuery<Record<string, string>>(
        CompiledQueryClass.raw(`explain ${cq.sql}`, [...cq.parameters])
      );
      return result.rows.map((row) => row['QUERY PLAN']).join('\n');
    });
  }

  return {
    ...compile,
    hasDb: !!realDb,
    // EXPLAIN the last compiled query; returns the plan text.
    explainLast: () => explain(compile.lastQuery()),
    // EXPLAIN every compiled query captured so far (a function may issue several); returns plans in order.
    explainAll: () => Promise.all(compile.queries.map(explain)),
    destroy: () => realDb?.destroy() ?? Promise.resolve(),
  };
}
