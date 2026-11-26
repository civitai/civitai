import { Prisma } from '@prisma/client';
import {
  DummyDriver,
  Kysely as KyselyCompiler,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type Kysely,
  type RawBuilder,
} from 'kysely';
import { PG_INT4_MAX, PG_INT4_MIN } from '~/server/common/constants';

/**
 * A statement built with `Prisma.sql`, run through Kysely over the app's pg pools instead of the
 * Prisma query engine.
 *
 * `Prisma.sql` is a plain template builder: it flattens nested fragments, `Prisma.join` lists and
 * `Prisma.raw` text into `strings` and `values`, and never touches the engine. Only `$queryRaw`
 * does. So a hot raw read keeps its statement, and the fragments it shares with the Prisma paths
 * that still use them, and swaps only the executor: Kysely sends the same text, with each value a
 * `$n` parameter in the same order (`prisma-sql-kysely.test.ts` pins this).
 *
 * 🔴 The text is the same; the parsing of what comes back is not. Prisma's raw reads return int8 as
 * `bigint` and numeric as `Prisma.Decimal`; the Kysely pools parse both to `number`
 * (`@civitai/db/kysely`). timestamp, timestamptz, json, booleans and int4 come back alike. Read a
 * ported statement's column types before trusting its row type.
 */
export function fromPrismaSql<T>(statement: Prisma.Sql): RawBuilder<T> {
  // Kysely's tag only reads the pieces in order, never `.raw`, so a plain array stands in for the
  // TemplateStringsArray its signature names.
  return sql<T>(statement.strings as unknown as TemplateStringsArray, ...statement.values);
}

// Compiles only; never connects.
const compiler = new KyselyCompiler<Record<string, never>>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

/**
 * A Kysely `sql` fragment as a `Prisma.sql` one, its values bound in the same order, for a statement
 * that has to stay on Prisma (one that joins a batch `$transaction`). Refuses a fragment whose text
 * holds a `$<digit>` of its own, which would bind values out of place.
 */
export function toPrismaSql(fragment: RawBuilder<unknown>): Prisma.Sql {
  const { sql: text, parameters } = fragment.compile(compiler);
  const pieces = text.split(/\$\d+/);
  if (pieces.length !== parameters.length + 1)
    throw new Error('toPrismaSql: the fragment has a "$<digit>" of its own');
  // Like `fromPrismaSql`, a plain array stands in for the TemplateStringsArray.
  return Prisma.sql(pieces as unknown as TemplateStringsArray, ...(parameters as unknown[]));
}

/**
 * Whether `id` fits an int4 column. 🔴 Binding is another difference: Prisma's raw reads answered
 * `id = ${n}` against an int4 column with no rows for an `n` past int4, while the pg pools send
 * the value as an untyped parameter that Postgres reads as int4 and rejects as out of range, an
 * error where Prisma answered "not found". A ported statement whose id comes from a caller drops
 * or short-circuits ids that fail this before it runs.
 */
export const isPgInt4 = (id: number) =>
  Number.isInteger(id) && id >= PG_INT4_MIN && id <= PG_INT4_MAX;

/** The rows of a `Prisma.sql` statement, run through Kysely (see `fromPrismaSql`). */
export async function queryPrismaSql<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Kysely<any>,
  statement: Prisma.Sql
): Promise<T[]> {
  const { rows } = await fromPrismaSql<T>(statement).execute(db);
  return rows;
}
