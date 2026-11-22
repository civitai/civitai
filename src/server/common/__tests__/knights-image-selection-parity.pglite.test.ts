import { PGlite } from '@electric-sql/pglite';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { imageNotRestricted } from '@civitai/db/knights';
import { imageNotRestrictedSql } from '~/server/common/image-visibility';
import { NsfwLevel } from '~/server/common/enums';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const LEVELS = [
  0,
  NsfwLevel.PG,
  NsfwLevel.PG13,
  NsfwLevel.R,
  NsfwLevel.X,
  NsfwLevel.XXX,
  NsfwLevel.Blocked,
];

// Compiles only: the rows are read through PGlite.
const kysely = new Kysely<DB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY, "nsfwLevel" int NOT NULL, "modelRestricted" boolean, "postId" int);
    CREATE TABLE "Post" (id int PRIMARY KEY);
  `);
  let id = 0;
  for (const level of LEVELS)
    for (const flag of [true, false, null])
      await pg.query(`INSERT INTO "Image" VALUES ($1, $2, $3, NULL)`, [++id, level, flag]);
});
afterAll(() => pg.close());

describe('imageNotRestricted (Kysely)', () => {
  it('keeps exactly the rows imageNotRestrictedSql keeps, for every level and flag value', async () => {
    const prisma = imageNotRestrictedSql();
    const expected = await pg.query<{ id: number }>(
      `SELECT id FROM "Image" i WHERE ${prisma.text} ORDER BY id`,
      prisma.values
    );
    const compiled = kysely
      .selectFrom('Image as img')
      .leftJoin('Post as p', 'p.id', 'img.postId')
      .select('img.id')
      .where(imageNotRestricted)
      .orderBy('img.id')
      .compile();
    const actual = await pg.query<{ id: number }>(compiled.sql, [...compiled.parameters]);

    expect(actual.rows.map((r) => r.id)).toEqual(expected.rows.map((r) => r.id));
    // Both directions are exercised: some rows are dropped and some kept.
    expect(expected.rows.length).toBeGreaterThan(0);
    expect(expected.rows.length).toBeLessThan(LEVELS.length * 3);
  });
});
