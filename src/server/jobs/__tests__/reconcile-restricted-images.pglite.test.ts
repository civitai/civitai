import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The job's chunk statement, run against PGlite: it counts only the rows it actually updated, and
 * hands back each touched post once so the showcase caches of those posts can be refreshed.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const bustCachesForPosts = vi.fn(async (_postIds: number[]) => undefined);
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  bustCachesForPosts: (postIds: number[]) => bustCachesForPosts(postIds),
}));
vi.mock('~/shared/constants/basemodel.constants', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  matureRestrictedBaseModels: () => ['Restricted'],
}));

const { reconcileRestrictedImages } = await import('~/server/jobs/reconcile-restricted-images');

const RESTRICTED_VERSION = 1;
const OTHER_VERSION = 2;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "baseModel" text NOT NULL);
    CREATE TABLE "ImageResourceNew" ("imageId" int NOT NULL, "modelVersionId" int NOT NULL);
    CREATE TABLE "Image" (id int PRIMARY KEY, "postId" int, "modelRestricted" boolean NOT NULL DEFAULT false);

    INSERT INTO "ModelVersion" VALUES (${RESTRICTED_VERSION}, 'Restricted'), (${OTHER_VERSION}, 'Open');
    INSERT INTO "Image" VALUES
      (1, 7, false), (2, 7, false), -- two images of one post
      (3, NULL, false),             -- postless
      (4, 8, true),                 -- already restricted
      (5, 9, false);                -- made with an open base model
    INSERT INTO "ImageResourceNew" VALUES
      (1, ${RESTRICTED_VERSION}), (2, ${RESTRICTED_VERSION}), (3, ${RESTRICTED_VERSION}),
      (4, ${RESTRICTED_VERSION}), (5, ${OTHER_VERSION}),
      (99, ${RESTRICTED_VERSION}); -- names an image that no longer exists
  `);
  // Integers typed as Prisma sends them: untyped, `"modelVersionId" IN ($1)` compares int to text.
  const INT4_OID = 23;
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    const { Prisma: P } = await import('@prisma/client');
    const sql = Array.isArray(strings)
      ? P.sql(strings as TemplateStringsArray, ...values)
      : (strings as Prisma.Sql);
    const paramTypes = sql.values.map((v) => (Number.isInteger(v) ? INT4_OID : 0));
    return (await db.query(sql.text, sql.values, { paramTypes })).rows;
  }) as never);
});
afterAll(() => db.close());

describe('reconcile-restricted-images chunk statement', () => {
  it('counts the rows it updated and refreshes each touched post once', async () => {
    const result = (await reconcileRestrictedImages.run({}).result) as { flagged: number };

    expect(result.flagged).toBe(3);
    expect(bustCachesForPosts.mock.calls).toEqual([[[7]]]);
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM "Image" WHERE "modelRestricted" ORDER BY id`
    );
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });
});
