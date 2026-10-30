import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
// STATIC import for the same reason as get-models-raw.paid-access-filter.test.ts: model.service is
// a very large module and its cold transform belongs to collection, not to the first test.
import {
  MODEL_NEEDS_REVIEW_WITHOUT_RULES_SQL,
  getModels,
  getModelsRaw,
} from '~/server/services/model.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

redisMock.redis.packed.get.mockImplementation(async () => null);
redisMock.redis.packed.set.mockImplementation(async () => undefined);

const { capturedQueries } = vi.hoisted(() => ({ capturedQueries: [] as { sql: string }[] }));

vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {
    cancellableQuery: vi.fn(async (query: { sql: string }) => {
      capturedQueries.push(query);
      return { result: async () => [], cancel: async () => undefined };
    }),
  },
  pgDbWrite: {},
  pgDbReadLong: {},
}));
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn().mockResolvedValue(false) }));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn().mockResolvedValue({ emptyResult: false }),
}));

const moderator = { id: 1, isModerator: true } as never;

async function needsReviewSql(user: unknown = moderator) {
  capturedQueries.length = 0;
  await getModelsRaw({
    input: { browsingLevel: 1, take: 10, needsReview: true } as never,
    user: user as never,
  });
  expect(capturedQueries).toHaveLength(1);
  return capturedQueries[0].sql;
}

async function needsReviewWhere() {
  dbMock.dbRead.model.findMany.mockResolvedValue([]);
  await getModels({
    input: { needsReview: true, take: 10, period: 'AllTime' } as never,
    select: { id: true },
    user: moderator,
  });
  return dbMock.dbRead.model.findMany.mock.calls.at(-1)![0].where as {
    AND: { OR?: unknown[] }[];
  };
}

describe('Models Needing Review leaves out Model rules takedowns', () => {
  it('the raw query only lists a flagged model that carries no modelRules claim', async () => {
    const sql = await needsReviewSql();
    expect(sql).toContain(MODEL_NEEDS_REVIEW_WITHOUT_RULES_SQL.sql);
    // Version-level reviews are unrelated to the rules and stay listed.
    expect(sql).toMatch(/mv\."meta"->>'needsReview' = 'true'/);
  });

  it('the Prisma query requires the modelRules key to be absent beside needsReview', async () => {
    const where = await needsReviewWhere();
    const or = where.AND.find((clause) => clause.OR)!.OR as Record<string, unknown>[];
    const modelLevel = or[0] as { AND: { meta: { path: string[]; equals: unknown } }[] };
    expect(modelLevel.AND.map((c) => [c.meta.path, c.meta.equals])).toEqual([
      [['needsReview'], true],
      [['modelRules'], Prisma.AnyNull],
    ]);
    expect(or[1]).toHaveProperty('modelVersions');
  });

  it('the raw clause lists a flagged model without the key or with a JSON-null one, never one with a claim', async () => {
    const pg = await PGlite.create();
    try {
      await pg.exec(`CREATE TABLE "Model" ("id" INT PRIMARY KEY, "meta" JSONB)`);
      await pg.query(
        `INSERT INTO "Model" VALUES (1, '{"needsReview": true}'), (2, '{"needsReview": true, "modelRules": null}'),
           (3, '{"needsReview": true, "modelRules": {"ruleIds": [1], "textHash": "h"}}'), (4, '{"modelRules": null}')`
      );
      const { rows } = await pg.query<{ id: number }>(
        `SELECT m."id" FROM "Model" m WHERE ${MODEL_NEEDS_REVIEW_WITHOUT_RULES_SQL.sql} ORDER BY m."id"`
      );
      expect(rows.map((r) => r.id)).toEqual([1, 2]);
    } finally {
      await pg.close();
    }
  });

  it('adds no review clause for a non-moderator', async () => {
    capturedQueries.length = 0;
    await getModelsRaw({
      input: { browsingLevel: 1, take: 10, needsReview: true } as never,
      user: { id: 2, isModerator: false } as never,
    });
    expect(capturedQueries[0].sql).not.toContain(`'needsReview'`);
  });
});
