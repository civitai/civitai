import {
  type CompiledQuery,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { connect } from '../infra/client';

// An offline Kysely wired to DummyDriver: query builders compile to real Postgres SQL and `.execute()`
// resolves to an empty result set WITHOUT a database. A `log` hook captures each compiled query so a test
// can assert the exact SQL + parameters a query function produces — enough to catch a refactor that drops a
// filter, loses the nulls-last ordering, or would emit `IN ()`. Behaviour/plan checks that need real rows or
// EXPLAIN belong in the app's DB-backed integration tests (see the package README).
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
