import { PGlite } from '@electric-sql/pglite';
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type QueryResult,
} from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { gradeKnightsVotes } from './knights';

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(`CREATE TABLE "KnightsVote" (
    "id" SERIAL PRIMARY KEY, "itemId" INTEGER NOT NULL, "answer" TEXT NOT NULL,
    "verdict" TEXT NOT NULL DEFAULT 'pending'
  )`);
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const result = await pg.query(compiled.sql, [...compiled.parameters]);
      return { rows: result.rows as R[], numAffectedRows: BigInt(result.affectedRows ?? 0) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('streaming is not used');
    },
  };
  const dialect: Dialect = {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => ({
      init: async () => undefined,
      acquireConnection: async () => connection,
      beginTransaction: async () => undefined,
      commitTransaction: async () => undefined,
      rollbackTransaction: async () => undefined,
      releaseConnection: async () => undefined,
      destroy: async () => undefined,
    }),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
  db = new Kysely<DB>({ dialect });
});

afterAll(async () => {
  await pg.close();
});

describe('gradeKnightsVotes', () => {
  it('grades pending votes of one item against the answer and leaves everything else alone', async () => {
    await pg.exec(`INSERT INTO "KnightsVote" ("itemId","answer","verdict") VALUES
      (1,'8','pending'), (1,'2','pending'), (1,'8','inconclusive'), (2,'8','pending')`);

    await gradeKnightsVotes(db, 1, '8');

    const { rows } = await pg.query<{ itemId: number; answer: string; verdict: string }>(
      `SELECT "itemId","answer","verdict" FROM "KnightsVote" ORDER BY "id"`
    );
    expect(rows.map((r) => r.verdict)).toEqual(['correct', 'failed', 'inconclusive', 'pending']);
  });
});
