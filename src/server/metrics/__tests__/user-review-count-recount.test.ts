import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as BaseMetrics from '~/server/metrics/base.metrics';
import type * as UsersSearchIndex from '~/server/search-index/users.search-index';

/**
 * A review from an unpublished post is left out of its author's reviewCount. The post going live
 * changes nothing on the review but `updatedAt`, so the recount has to pick that up.
 */

// The processor's own update, without the job runner around it.
vi.mock('~/server/metrics/base.metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof BaseMetrics>()),
  createMetricProcessor: (options: unknown) => options,
}));
vi.mock('~/server/search-index/users.search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof UsersSearchIndex>()),
  usersSearchIndex: { queueUpdate: async () => undefined },
}));

const { userMetrics } = await import('~/server/metrics/user.metrics');

const LAST_UPDATE = new Date('2026-11-01T00:00:00Z');
const RELEASED = 1;
const UNTOUCHED = 2;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamp(3));
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, status text NOT NULL);
    CREATE TABLE "ResourceReview" (
      id int PRIMARY KEY, "userId" int NOT NULL, "modelVersionId" int NOT NULL, "postId" int,
      "createdAt" timestamp(3) NOT NULL, "updatedAt" timestamp(3) NOT NULL
    );
    INSERT INTO "Post" VALUES (1, '2026-11-02T00:00:00Z');
    INSERT INTO "ModelVersion" VALUES (20, 'Published');
    INSERT INTO "ResourceReview" VALUES
      (1, ${RELEASED}, 20, 1, '2026-10-20T00:00:00Z', '2026-11-02T00:00:00Z'),
      (2, ${UNTOUCHED}, 20, NULL, '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z');
  `);
});

describe('user reviewCount recount', () => {
  it('recounts an author whose review was only touched since the last run', async () => {
    const reviewSql = (sql: string) => sql.includes('"ResourceReview"');
    const ctx = {
      lastUpdate: LAST_UPDATE,
      queue: [] as number[],
      affected: new Set<number>(),
      addAffected(id: number | number[]) {
        for (const x of [id].flat()) ctx.affected.add(x);
      },
      jobContext: { checkIfCanceled: () => undefined, on: () => undefined },
      ch: { $query: async () => [] },
      pg: {
        cancellableQuery: async (sql: string, params: unknown[]) => ({
          cancel: () => undefined,
          result: async () => (reviewSql(sql) ? (await pg.query(sql, params)).rows : []),
        }),
      },
    };

    await (userMetrics as unknown as { update: (c: typeof ctx) => Promise<void> }).update(ctx);

    expect([...ctx.affected]).toEqual([RELEASED]);
  });
});
