import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

/** A query builder that compiles Postgres SQL and never connects. */
export const offlineDb = () =>
  new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });

/** A compiled statement with its parameters written in, for a reviewed run by hand. */
export function inlineSql({ sql: text, parameters }: CompiledQuery): string {
  const literal = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return String(value);
    if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
    throw new Error(`Cannot inline a parameter of type ${typeof value}.`);
  };
  return text.replace(/\$(\d+)/g, (_, n: string) => {
    const index = Number(n) - 1;
    if (index >= parameters.length) throw new Error(`No parameter for $${n}.`);
    return literal(parameters[index]);
  });
}
