import type { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  CLEAN,
  MARKED,
  REPORTED,
  commentsLeft,
  createModelHoldDb,
  holdOwner,
  seedModelHoldDb,
  seedReviewThread,
  versionOf,
} from './model-legal-hold.fixture';

/**
 * Deleting a review or an answer directly, by its author or a moderator, keeps a copy of a held
 * author's row. The delete statements run against a Postgres stand-in; the rest of each service is
 * real.
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

import { deleteAnswer } from '~/server/services/answer.service';
import {
  deleteResourceReview,
  deleteResourceReviews,
} from '~/server/services/resourceReview.service';
import { toggleReview } from '~/server/services/user.service';

let db: PGlite;
let before: (() => Promise<unknown>) | null = null;

const QUESTION = 40;
const reviewOf = (author: number) => author * 1000;
const answerOf = (author: number) => author * 1000 + 1;

beforeAll(async () => {
  db = await createModelHoldDb();
  await db.exec(`
    ALTER TABLE "Thread"
      ADD COLUMN "answerId" int UNIQUE REFERENCES "Answer"(id) ON DELETE CASCADE;
  `);
});

beforeEach(async () => {
  vi.clearAllMocks();
  before = null;
  await seedModelHoldDb(db);
  await db.exec(`
    TRUNCATE "Answer", "HeldAnswer" CASCADE;
    INSERT INTO "ResourceReview" (id, "userId", "modelVersionId", "modelId", recommended, details)
      SELECT a * 1000, a, a * 100 + 1, a * 10, false, 'review by ' || a
      FROM unnest(ARRAY[${CLEAN}, ${REPORTED}, ${MARKED}]) a;
    INSERT INTO "Answer" (id, "userId", "questionId", content)
      SELECT a * 1000 + 1, a, ${QUESTION}, 'answer by ' || a
      FROM unnest(ARRAY[${CLEAN}, ${REPORTED}, ${MARKED}]) a;
  `);
  const send = async (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) => {
    const sql = Array.isArray(first)
      ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
      : (first as Prisma.Sql);
    if (before && /^\s*WITH/.test(sql.text)) await before();
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
const heldReviews = async () =>
  (
    await db.query<{ id: number; details: string; holdReasons: string[] }>(
      `SELECT id, details, "holdReasons" FROM "HeldResourceReview" ORDER BY id`
    )
  ).rows;
const answerIds = async () =>
  (await db.query<{ id: number }>(`SELECT id FROM "Answer" ORDER BY id`)).rows.map((r) => r.id);
const heldAnswers = async () =>
  (
    await db.query<{ id: number; content: string }>(
      `SELECT id, content FROM "HeldAnswer" ORDER BY id`
    )
  ).rows;

describe('deleteResourceReview', () => {
  it('deletes a held author review and keeps a copy of it', async () => {
    await deleteResourceReview({ id: reviewOf(MARKED) });

    expect(await reviewIds()).not.toContain(reviewOf(MARKED));
    const copies = await heldReviews();
    expect(copies.map((c) => [c.id, c.details])).toEqual([
      [reviewOf(MARKED), `review by ${MARKED}`],
    ]);
    expect(copies[0].holdReasons.length).toBeGreaterThan(0);
  });

  it('keeps a copy for an author named on a pending report', async () => {
    await deleteResourceReview({ id: reviewOf(REPORTED) });

    expect((await heldReviews()).map((c) => c.id)).toEqual([reviewOf(REPORTED)]);
  });

  it('deletes an unheld author review with no copy (control)', async () => {
    await deleteResourceReview({ id: reviewOf(CLEAN) });

    expect(await reviewIds()).toEqual([reviewOf(REPORTED), reviewOf(MARKED)]);
    expect(await heldReviews()).toEqual([]);
  });

  it('copies a review whose author is held just before the delete runs', async () => {
    before = () => holdOwner(db, CLEAN);
    await deleteResourceReview({ id: reviewOf(CLEAN) });

    expect((await heldReviews()).map((c) => c.id)).toEqual([reviewOf(CLEAN)]);
  });

  it('returns the deleted row as the client reads it', async () => {
    const ret = await deleteResourceReview({ id: reviewOf(CLEAN) });

    expect(ret).toMatchObject({
      id: reviewOf(CLEAN),
      userId: CLEAN,
      modelId: CLEAN * 10,
      modelVersionId: versionOf(CLEAN),
      rating: 5,
      recommended: false,
      nsfw: false,
    });
    expect(ret.createdAt).toBeInstanceOf(Date);
  });

  it('reports an unknown review not found and deletes nothing', async () => {
    await expect(deleteResourceReview({ id: 999_999 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await reviewIds()).toHaveLength(3);
  });

  it('still detaches a thread a held account commented in', async () => {
    await seedReviewThread(db, {
      reviewId: 5000,
      versionId: versionOf(CLEAN, 2),
      reviewer: CLEAN,
      commenter: MARKED,
    });
    await deleteResourceReview({ id: 5000 });

    expect(await commentsLeft(db)).toEqual([{ id: 5000, onReview: false }]);
  });
});

describe('deleteResourceReviews', () => {
  it('copies only the held authors among the reviews it deletes', async () => {
    const { count } = await deleteResourceReviews({
      ids: [reviewOf(CLEAN), reviewOf(REPORTED), reviewOf(MARKED)],
    });

    expect(count).toBe(3);
    expect(await reviewIds()).toEqual([]);
    expect((await heldReviews()).map((c) => c.id)).toEqual([reviewOf(REPORTED), reviewOf(MARKED)]);
  });

  it('counts only the reviews it found', async () => {
    const { count } = await deleteResourceReviews({ ids: [reviewOf(CLEAN), 999_999] });

    expect(count).toBe(1);
  });
});

describe('deleteAnswer', () => {
  it('deletes a held author answer and keeps a copy of it', async () => {
    await deleteAnswer({ id: answerOf(MARKED) });

    expect(await answerIds()).not.toContain(answerOf(MARKED));
    expect(await heldAnswers()).toEqual([{ id: answerOf(MARKED), content: `answer by ${MARKED}` }]);
  });

  it('deletes an unheld author answer with no copy (control)', async () => {
    await deleteAnswer({ id: answerOf(CLEAN) });

    expect(await answerIds()).toEqual([answerOf(REPORTED), answerOf(MARKED)]);
    expect(await heldAnswers()).toEqual([]);
  });

  it('still detaches a thread a held account commented in', async () => {
    await db.exec(`
      INSERT INTO "Thread" (id, "answerId") VALUES (6000, ${answerOf(CLEAN)});
      INSERT INTO "CommentV2" VALUES (6000, ${MARKED}, 6000);
    `);
    await deleteAnswer({ id: answerOf(CLEAN) });

    expect((await db.query(`SELECT id, "answerId" FROM "Thread" WHERE id = 6000`)).rows).toEqual([
      { id: 6000, answerId: null },
    ]);
  });

  it('reports an unknown answer not found and deletes nothing', async () => {
    await expect(deleteAnswer({ id: 999_999 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await answerIds()).toHaveLength(3);
  });
});

describe('toggleReview off', () => {
  it('copies a held author review it removes', async () => {
    await toggleReview({ modelId: MARKED * 10, userId: MARKED, setTo: false });

    expect(await reviewIds()).not.toContain(reviewOf(MARKED));
    expect((await heldReviews()).map((c) => c.id)).toEqual([reviewOf(MARKED)]);
  });

  it('removes an unheld author review with no copy (control)', async () => {
    await toggleReview({ modelId: CLEAN * 10, userId: CLEAN, setTo: false });

    expect(await reviewIds()).not.toContain(reviewOf(CLEAN));
    expect(await heldReviews()).toEqual([]);
  });
});
