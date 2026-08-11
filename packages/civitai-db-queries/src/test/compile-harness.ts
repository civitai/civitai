import {
  type CompiledQuery,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { UPDATED_AT_TABLES } from '@civitai/db-schema/kysely/updated-at-tables';
import { updatedAtPlugin } from '../infra/updated-at-plugin';

// This module is the ONLY thing the package's public `./test-harness` subpath exports, and it is
// deliberately kept in its own file rather than living beside `explainHarness`/`testDbUrl` in
// `harness.ts`. Those two resolve a connection string, falling back to `process.env.DATABASE_URL` —
// a REAL environment's writer in any checkout that has one — so exporting them across a package
// boundary would let a non-test importer open a second pool against production by calling one
// function. Nothing reachable from here touches a connection string or opens a socket; the parity
// suite's refusal to fall back to `DATABASE_URL` is a property of the whole module graph it imports,
// not just of its own code. Pinned by `harness-exports.test.ts`.

// Query functions take a Kysely client as their first argument (executor injection). This harness builds
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
    // The most recently compiled query — `{ sql, parameters }`. A caller that must not miss a
    // statement should read `queries` instead: a function may issue several, and reading only the
    // last one is how a guard over this harness silently stopped seeing the earlier ones.
    lastQuery: () => queries[queries.length - 1],
    queries,
  };
}
