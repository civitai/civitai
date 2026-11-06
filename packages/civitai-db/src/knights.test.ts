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
import { closeYesNoItemRow, gradeKnightsVotes } from './knights';

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(`CREATE TABLE "KnightsVote" (
    "id" SERIAL PRIMARY KEY, "itemId" INTEGER NOT NULL, "answer" TEXT NOT NULL,
    "verdict" TEXT NOT NULL DEFAULT 'pending'
  )`);
  await pg.exec(`CREATE TABLE "KnightsQueueItem" (
    "id" INTEGER PRIMARY KEY, "status" TEXT NOT NULL DEFAULT 'Open', "reason" TEXT,
    "resolvedAt" TIMESTAMP, "updatedAt" TIMESTAMP, "meta" JSONB
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

describe('closeYesNoItemRow', () => {
  it('closes the item with the reason, merges the meta patch and makes only its pending votes inconclusive', async () => {
    await pg.exec(`DELETE FROM "KnightsVote";
      INSERT INTO "KnightsQueueItem" ("id","meta") VALUES (10,'{"keep":"1"}'), (11,NULL);
      INSERT INTO "KnightsVote" ("itemId","answer","verdict") VALUES
      (10,'yes','pending'), (10,'no','correct'), (11,'yes','pending')`);

    await closeYesNoItemRow(db, 10, 'moderator-retired', new Date('2026-12-01T10:00:00Z'), {
      moderation: { by: 4 },
    });

    const item = await pg.query<Record<string, unknown>>(
      `SELECT "status","reason","meta","resolvedAt"::text AS "resolvedAt" FROM "KnightsQueueItem" WHERE "id" = 10`
    );
    expect(item.rows[0]).toMatchObject({
      status: 'Closed',
      reason: 'moderator-retired',
      meta: { keep: '1', moderation: { by: 4 } },
    });
    expect(item.rows[0].resolvedAt).toBe('2026-12-01 10:00:00');
    const votes = await pg.query<{ itemId: number; verdict: string }>(
      `SELECT "itemId","verdict" FROM "KnightsVote" ORDER BY "id"`
    );
    expect(votes.rows.map((v) => `${v.itemId}:${v.verdict}`)).toEqual([
      '10:inconclusive',
      '10:correct',
      '11:pending',
    ]);
  });

  it('leaves meta alone without a patch', async () => {
    await closeYesNoItemRow(db, 11, 'moderator-retired', new Date());
    const { rows } = await pg.query<{ meta: unknown }>(
      `SELECT "meta" FROM "KnightsQueueItem" WHERE "id" = 11`
    );
    expect(rows[0].meta).toBeNull();
  });
});
