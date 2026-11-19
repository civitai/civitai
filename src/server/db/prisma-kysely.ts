import type { DB } from '@civitai/db-schema/kysely';
import type { Prisma } from '@prisma/client';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';

type RawClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * A Kysely client that runs each statement through `client.$queryRaw`, so an `@civitai/db-queries`
 * function can join an open Prisma transaction. Rows come back as Prisma's raw reads parse them
 * (int8 as bigint, numeric as Decimal), not as the pg pools do.
 */
export function kyselyOver(client: RawClient): Kysely<DB> {
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new PrismaDriver(client),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

class PrismaConnection implements DatabaseConnection {
  constructor(private readonly client: RawClient) {}

  async executeQuery<R>({ sql, parameters }: CompiledQuery): Promise<QueryResult<R>> {
    // Kysely numbers its placeholders $1..$n in order, so the text between them is a template. A
    // `$<digit>` in a literal would shift every value after it, so that refuses instead.
    const pieces = sql.split(/\$\d+/);
    if (pieces.length !== parameters.length + 1)
      throw new Error('kyselyOver: a statement with "$<digit>" outside its placeholders');
    const strings = Object.assign(pieces, { raw: pieces });
    const rows = await this.client.$queryRaw<R[]>(strings, ...parameters);
    return { rows };
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('kyselyOver does not stream');
  }
}

const done = async () => undefined;

class PrismaDriver implements Driver {
  constructor(private readonly client: RawClient) {}
  init = done;
  async acquireConnection() {
    return new PrismaConnection(this.client);
  }
  async beginTransaction() {
    throw new Error('kyselyOver cannot open a transaction: pass it a Prisma transaction client');
  }
  commitTransaction = done;
  rollbackTransaction = done;
  releaseConnection = done;
  destroy = done;
}
