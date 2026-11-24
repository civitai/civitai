import type { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  OTHER,
  OWNER,
  commentsLeft,
  createModelDb,
  seedModelDb,
  seedReviewThread,
  versionOf,
} from './model-delete.fixture';

/**
 * Deleting a review directly, by its author or a moderator. The delete statements run against a
 * Postgres stand-in; the rest of each service is real.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  bustRatingTotalsCache: vi.fn(() => Promise.resolve()),
}));
vi.mock('~/server/metrics', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  modelMetrics: { queueUpdate: vi.fn() },
}));

import {
  deleteResourceReview,
  deleteResourceReviews,
} from '~/server/services/resourceReview.service';
import { toggleReview } from '~/server/services/user.service';

let db: PGlite;

const reviewOf = (author: number) => author * 1000;

beforeAll(async () => {
  db = await createModelDb();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await seedModelDb(db);
  await db.exec(`
    INSERT INTO "ResourceReview"
      (id, "userId", "modelVersionId", "modelId", rating, recommended, nsfw, details)
      SELECT a * 1000, a, a * 100 + 1, a * 10, 3, false, true, 'review by ' || a
      FROM unnest(ARRAY[${OWNER}, ${OTHER}]) a;
  `);
  const send = async (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) => {
    const sql = Array.isArray(first)
      ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
      : (first as Prisma.Sql);
    return db.query(sql.text, sql.values);
  };
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(
    (async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
      (await send(first, values)).rows) as never
  );
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation(
    (async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
      (await send(first, values)).affectedRows ?? 0) as never
  );
});

const reviewIds = async () =>
  (await db.query<{ id: number }>(`SELECT id FROM "ResourceReview" ORDER BY id`)).rows.map(
    (r) => r.id
  );

describe('deleteResourceReview', () => {
  it('deletes only that review', async () => {
    await deleteResourceReview({ id: reviewOf(OWNER) });

    expect(await reviewIds()).toEqual([reviewOf(OTHER)]);
  });

  it('returns the deleted row as the client reads it', async () => {
    const ret = await deleteResourceReview({ id: reviewOf(OWNER) });

    expect(ret).toMatchObject({
      id: reviewOf(OWNER),
      userId: OWNER,
      modelId: OWNER * 10,
      modelVersionId: versionOf(OWNER),
      rating: 3,
      recommended: false,
      nsfw: true,
    });
    expect(ret.createdAt).toBeInstanceOf(Date);
  });

  it('reports an unknown review not found and deletes nothing', async () => {
    await expect(deleteResourceReview({ id: 424242 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await reviewIds()).toHaveLength(2);
  });

  it('takes the comments on it with it', async () => {
    await seedReviewThread(db, {
      reviewId: 5000,
      versionId: versionOf(OWNER, 2),
      reviewer: OWNER,
      commenter: OTHER,
    });
    await deleteResourceReview({ id: 5000 });

    expect(await commentsLeft(db)).toEqual([]);
  });
});

describe('deleteResourceReviews', () => {
  it('deletes every review it is given', async () => {
    const { count } = await deleteResourceReviews({ ids: [reviewOf(OWNER), reviewOf(OTHER)] });

    expect(count).toBe(2);
    expect(await reviewIds()).toEqual([]);
  });

  it('counts only the reviews it found', async () => {
    const { count } = await deleteResourceReviews({ ids: [reviewOf(OWNER), 424242] });

    expect(count).toBe(1);
  });
});

describe('toggleReview off', () => {
  it("removes the author's review of the model, and no one else's", async () => {
    await toggleReview({ modelId: OWNER * 10, userId: OWNER, setTo: false });

    expect(await reviewIds()).toEqual([reviewOf(OTHER)]);
  });
});
