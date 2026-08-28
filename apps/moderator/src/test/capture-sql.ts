import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
} from 'kysely';

/**
 * A Kysely client that COMPILES queries and never connects, appending every statement it emits to `sql`.
 *
 * Three suites carried byte-identical copies of this before it moved here. The shape matters more than
 * the duplication: several of this app's queries are correct only in their emitted SQL — a raw `IN`
 * fragment that needs its own parens, a join that fans a row out, an ORDER BY that decides which half of
 * a capped result a moderator sees. All of those typecheck, lint, and pass against a hand-rolled fake.
 *
 * `sql` is passed in rather than returned because the caller declares it in `vi.hoisted`, above its own
 * imports, and the client has to be built inside the `vi.mock` factory.
 *
 * 🔴 **Pass `rows` for any chain that consumes a result.** With none, a chain stops at its first
 * `executeTakeFirstOrThrow` (or its first `if (!row) return null`) and every statement after it is never
 * compiled — `sql` goes short while assertions over its contents still pass, on a query that was never
 * built. That is not hypothetical: it left a `DELETE` unreachable in `abuse-detection.sql.test.ts`,
 * where a mutant widening its `WHERE` passed the whole suite. Assert the NUMBER of captured statements,
 * not only what is in them.
 *
 * The driver ignores the SQL and answers every query with the same `rows`, so the count a chain sees is
 * fixed here and never by the query's own LIMIT.
 */
export function capturingDb(sql: string[], rows: unknown[] = []): Kysely<never> {
  class CannedRowDriver extends DummyDriver {
    async acquireConnection(): Promise<DatabaseConnection> {
      return {
        // Generic in `R` to satisfy `DatabaseConnection`; a concrete row type here makes svelte-check
        // reject the whole dialect.
        executeQuery: async <R>() => ({ rows: rows as R[] }),
        streamQuery: async function* () {
          yield { rows: [] };
        },
      };
    }
  }

  return new Kysely<never>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new CannedRowDriver(),
      createIntrospector: (i) => new PostgresIntrospector(i),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (e) => {
      if (e.level === 'query') sql.push(e.query.sql);
    },
  });
}
