import {
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';

/**
 * Answers a statement the way a `$queryRaw` fake does: called with the statement's template strings
 * and its values, `(strings, ...values)`, as a tagged template would be. So the helpers written for
 * `$queryRaw` fakes (`respondWithRows`, `statementOf`, `pgliteRaw(db).queryRaw`) answer Kysely too.
 */
export type RawStatementHandler = (
  strings: readonly string[],
  ...values: unknown[]
) => Promise<unknown[]> | unknown[];

/**
 * A compiled Kysely statement as template strings and values: the text split on its `$n`
 * placeholders. Kysely numbers them in order of appearance, one per value, so the pieces line up
 * with `parameters`. Throws if they do not, rather than answering for a different statement.
 */
export function templateOf(compiled: CompiledQuery): [string[], ...unknown[]] {
  const placeholders = [...compiled.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  const inOrder = placeholders.every((n, i) => n === i + 1);
  if (!inOrder || placeholders.length !== compiled.parameters.length)
    throw new Error(
      `kysely-raw-fake: ${placeholders.length} placeholders for ${compiled.parameters.length} ` +
        `parameters, or out of order, in:\n${compiled.sql}`
    );
  return [compiled.sql.split(/\$\d+/), ...compiled.parameters];
}

/**
 * Throws as Postgres does when a statement binds an integer past int4 where it reads an int4 (an
 * `id = $1` on an int4 column, an `$1::int[]`): the pg pools send parameters untyped, so the server
 * types them from the statement and rejects the value. Opt-in, for a handler whose statement binds
 * only int4-typed numbers: call it first. Arrays are checked element by element.
 */
export function rejectPastInt4(values: readonly unknown[]): void {
  for (const value of values.flat()) {
    if (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      (value > 2_147_483_647 || value < -2_147_483_648)
    )
      throw new Error(`value "${value}" is out of range for type integer`);
  }
}

/**
 * A Kysely client whose every statement goes to `handler` instead of a database. Most tests want
 * it through `fakeKyselyDbLazy` below.
 *
 * Rows come back exactly as the handler returns them: no type parsing happens here, so what pg
 * would parse (int8, numeric, dates) is the handler's to model.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fakeKysely(handler: RawStatementHandler): Kysely<any> {
  const connection: DatabaseConnection = {
    async executeQuery(compiled) {
      const [strings, ...values] = templateOf(compiled);
      const rows = await handler(strings, ...values);
      return { rows: (rows ?? []) as never[] };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('kysely-raw-fake: streaming is not supported');
    },
  };
  const noop = async () => undefined;
  const dialect: Dialect = {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => ({
      init: noop,
      acquireConnection: async () => connection,
      beginTransaction: noop,
      commitTransaction: noop,
      rollbackTransaction: noop,
      releaseConnection: noop,
      destroy: noop,
    }),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
  return new Kysely({ dialect });
}

/**
 * A `~/server/db/kyselyDb.lazy` module whose `loadKyselyDb()` hands back fake read and write clients
 * (see `fakeKysely`), for the services that load Kysely on first use:
 *
 *     const kysely = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
 *     vi.mock('~/server/db/kyselyDb.lazy', async () =>
 *       (await import('~/test-utils/kysely-raw-fake')).fakeKyselyDbLazy(kysely.read, kysely.write)
 *     );
 *
 * The lazy module, not `~/server/db/kyselyDb` itself: measured, a service reaching
 * `import('~/server/db/kyselyDb')` through it could be handed the REAL module (and open a
 * connection) in a file whose own import of the same specifier got the mock.
 */
export function fakeKyselyDbLazy(read: RawStatementHandler, write: RawStatementHandler) {
  const db = { kyselyRead: fakeKysely(read), kyselyWrite: fakeKysely(write) };
  return { loadKyselyDb: async () => db };
}

/**
 * A handler that answers each statement with whatever `queryRawMock`'s implementation answers at the
 * time, WITHOUT recording a call on it. For a suite whose `$queryRaw` fake already models the
 * database (a PGlite, a fixture router) and now also has reads that go through Kysely:
 *
 *     vi.mock('~/server/db/kyselyDb.lazy', async () => {
 *       const { fakeKyselyDbLazy, answerLike } = await import('~/test-utils/kysely-raw-fake');
 *       const { dbMock } = await import('~/__tests__/mocks/db.mock');
 *       return fakeKyselyDbLazy(answerLike(dbMock.dbRead.$queryRaw), answerLike(dbMock.dbWrite.$queryRaw));
 *     });
 *
 * Not recording is the point: `$queryRaw`'s calls stay the Prisma engine's, so a test can still
 * assert a read never reached it. 🔴 It reads the BASE implementation only: a queued
 * `mockResolvedValueOnce` on `$queryRaw` is neither seen nor consumed. A test that answers the
 * Kysely read with a one-off row gives its own handler instead.
 */
export function answerLike(queryRawMock: {
  getMockImplementation(): ((...args: never[]) => unknown) | undefined;
}): RawStatementHandler {
  return async (strings, ...values) => {
    const implementation = queryRawMock.getMockImplementation() as
      | ((...args: unknown[]) => unknown)
      | undefined;
    return ((await implementation?.(strings, ...values)) ?? []) as unknown[];
  };
}
