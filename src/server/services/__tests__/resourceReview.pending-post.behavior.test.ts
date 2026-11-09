import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlockCheck from '~/server/services/block-check.service';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as NotificationService from '~/server/services/notification.service';
import type * as PointsHooks from '~/server/events/points/hooks';
import type * as ReviewCache from '~/server/services/resourceReview.cache';

/**
 * A review written from the edit page of an unpublished post went public at once and notified the
 * model owner, who then found no post and no images. It now waits for the post to go live.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { createNotification, bustRatingTotalsForRows } = vi.hoisted(() => ({
  createNotification: vi.fn<(row: unknown) => Promise<void>>(async () => undefined),
  bustRatingTotalsForRows: vi.fn<(rows: unknown[]) => Promise<void>>(async () => undefined),
}));

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  throwOnBlockedUserContent: async () => undefined,
}));
vi.mock('~/server/services/block-check.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockCheck>()),
  getBlockCheckOwnerIds: async () => [],
  throwIfBlockedByOwners: async () => undefined,
}));
vi.mock('~/server/services/resourceReview.cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ReviewCache>()),
  bustRatingTotalsCache: vi.fn(async () => undefined),
  bustRatingTotalsForRows,
}));
vi.mock('~/server/events/points/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof PointsHooks>()),
  onModelReviewsChanged: async () => undefined,
}));

const { createResourceReview, getResourceReview, getUserRatingTotals, upsertResourceReview } =
  await import('~/server/services/resourceReview.service');
const {
  refreshReviewsForUnpublishedPosts,
  releasePendingReviewsForPosts,
  visibleReviewForViewerSql,
} = await import('~/server/services/resourceReview.visibility');

const AUTHOR = 42;
const MODEL_OWNER = 7;
const DAY = 24 * 60 * 60 * 1000;

const review = { modelId: 10, modelVersionId: 20, rating: 5, recommended: true, details: null };

const postIs = (post: { userId: number; publishedAt: Date | null } | null) =>
  dbMock.dbWrite.post.findUnique.mockResolvedValue(post as never);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.resourceReview.create.mockImplementation((async ({ data }: { data: object }) => ({
    id: 1,
    ...data,
  })) as never);
  dbMock.dbWrite.resourceReview.update.mockResolvedValue({
    id: 1,
    modelId: 10,
    modelVersionId: 20,
    userId: AUTHOR,
  } as never);
  dbMock.dbRead.modelVersion.findFirst.mockResolvedValue({
    name: 'v1',
    model: { name: 'Model', userId: MODEL_OWNER },
  } as never);
  dbMock.dbRead.user.findFirst.mockResolvedValue({ username: 'author' } as never);
});

const createdData = () =>
  (dbMock.dbWrite.resourceReview.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;

describe('creating a review from a post', () => {
  it.each([
    ['a draft', null],
    ['a scheduled post', new Date(Date.now() + DAY)],
  ])('links it to %s of the author and holds the notification', async (_label, publishedAt) => {
    postIs({ userId: AUTHOR, publishedAt });

    await upsertResourceReview({ ...review, postId: 5, userId: AUTHOR });

    expect(createdData().postId).toBe(5);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it.each([
    ['a live post of the author', { userId: AUTHOR, publishedAt: new Date(Date.now() - DAY) }],
    ["someone else's draft", { userId: 99, publishedAt: null }],
    ['a post that does not exist', null],
  ])('ignores %s: a normal public review, notified at once', async (_label, post) => {
    postIs(post);

    await upsertResourceReview({ ...review, postId: 5, userId: AUTHOR });

    expect(createdData().postId).toBeUndefined();
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('holds the notification when a create race returns the existing pending review', async () => {
    postIs({ userId: AUTHOR, publishedAt: null });
    dbMock.dbWrite.resourceReview.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '1',
      }) as never
    );
    dbMock.dbWrite.resourceReview.findUniqueOrThrow.mockResolvedValueOnce({
      id: 1,
      ...review,
      postId: 5,
    } as never);

    await upsertResourceReview({ ...review, postId: 5, userId: AUTHOR });

    expect(createNotification).not.toHaveBeenCalled();
  });

  it('holds the notification when a plain create races a pending review from a post', async () => {
    dbMock.dbWrite.resourceReview.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '1',
      }) as never
    );
    dbMock.dbWrite.resourceReview.findUniqueOrThrow.mockResolvedValueOnce({
      id: 1,
      ...review,
      postId: 5,
    } as never);

    await createResourceReview({ ...review, userId: AUTHOR });

    expect(createNotification).not.toHaveBeenCalled();
  });

  it('never moves an existing review onto a post', async () => {
    dbMock.dbWrite.resourceReview.findUnique.mockResolvedValue({ modelId: 10 } as never);
    postIs({ userId: AUTHOR, publishedAt: null });

    await upsertResourceReview({ ...review, id: 1, postId: 5, userId: AUTHOR });

    const { data } = dbMock.dbWrite.resourceReview.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data).not.toHaveProperty('postId');
  });
});

describe('opening a pending review by id', () => {
  // Stands in for Postgres: a pending review matches only a query without the visibility filter.
  beforeEach(() => {
    dbMock.dbRead.resourceReview.findFirst.mockImplementation((async ({
      where,
    }: {
      where: Record<string, unknown>;
    }) =>
      'OR' in where
        ? null
        : {
            id: 1,
            user: { id: AUTHOR },
            model: { name: 'Model', id: 10, userId: MODEL_OWNER, status: 'Published' },
          }) as never);
  });

  it('opens it for a moderator', async () => {
    const result = await getResourceReview({ id: 1, userId: 3, isModerator: true });

    expect(result.id).toBe(1);
  });

  it('is not found for anyone else', async () => {
    await expect(getResourceReview({ id: 1, userId: 999 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('against Postgres', () => {
  let pg: PGlite;
  const DRAFT = 1;
  const SCHEDULED = 2;
  const LIVE = 3;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
      CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamp(3));
      CREATE TABLE "ResourceReview" (
        id int PRIMARY KEY, "modelId" int NOT NULL, "modelVersionId" int NOT NULL,
        "userId" int NOT NULL, rating int NOT NULL DEFAULT 5, recommended boolean NOT NULL DEFAULT true,
        exclude boolean NOT NULL DEFAULT false, "postId" int,
        "updatedAt" timestamp(3) NOT NULL DEFAULT now() - interval '2 days'
      );
      INSERT INTO "Model" VALUES (10, ${MODEL_OWNER});
    `);
  });

  beforeEach(async () => {
    await pg.exec(`
      TRUNCATE "Post", "ResourceReview";
      INSERT INTO "Post" VALUES
        (${DRAFT}, NULL), (${SCHEDULED}, now() + interval '1 day'), (${LIVE}, now() - interval '1 day');
    `);
    const run = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...(values as never[]));
      return (await pg.query(sql.text, sql.values as unknown[])).rows;
    }) as never;
    dbMock.dbRead.$queryRaw.mockImplementation(run);
    dbMock.dbWrite.$queryRaw.mockImplementation(run);
  });

  const insertReviews = (rows: [id: number, userId: number, postId: number | null][]) =>
    pg.exec(
      `INSERT INTO "ResourceReview" (id, "modelId", "modelVersionId", "userId", "postId") VALUES ${rows
        .map(([id, userId, postId]) => `(${id}, 10, ${20 + id}, ${userId}, ${postId ?? 'NULL'})`)
        .join(', ')}`
    );

  const visibleIds = async (viewerId?: number) => {
    const { rows } = await pg.query<{ id: number }>(
      `SELECT rr.id FROM "ResourceReview" rr WHERE ${
        Prisma.sql`${visibleReviewForViewerSql('rr', viewerId)}`.text
      } ORDER BY rr.id`,
      viewerId ? [viewerId] : []
    );
    return rows.map((row) => row.id);
  };

  it.each([
    ['anyone signed out', undefined, [1, 4]],
    ['a stranger', 999, [1, 4]],
    ['the author of the pending reviews', AUTHOR, [1, 2, 3, 4]],
  ])('shows %s only the reviews they may see', async (_label, viewerId, expected) => {
    await insertReviews([
      [1, 101, null],
      [2, AUTHOR, DRAFT],
      [3, AUTHOR, SCHEDULED],
      [4, 104, LIVE],
    ]);

    expect(await visibleIds(viewerId)).toEqual(expected);
  });

  it("leaves reviews from posts not yet live out of the model owner's totals", async () => {
    await insertReviews([
      [1, 101, null],
      [2, 102, DRAFT],
      [3, 103, SCHEDULED],
      [4, 104, LIVE],
    ]);

    const totals = await getUserRatingTotals({ userId: MODEL_OWNER });

    expect(totals.up).toBe(2);
  });

  it('releases the reviews of a post that is live: notified, and touched for the metric jobs', async () => {
    await insertReviews([
      [1, 101, LIVE],
      [2, 102, SCHEDULED],
    ]);

    const released = await releasePendingReviewsForPosts([LIVE, SCHEDULED]);

    // The model owner, whose "has received reviews" flag the caller refreshes.
    expect(released).toEqual([expect.objectContaining({ id: 1, modelOwnerId: MODEL_OWNER })]);

    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'new-review:21:101', userId: MODEL_OWNER })
    );
    const { rows } = await pg.query<{ id: number; touched: boolean }>(
      `SELECT id, "updatedAt" > now() - interval '1 minute' AS touched FROM "ResourceReview" ORDER BY id`
    );
    expect(rows).toEqual([
      { id: 1, touched: true },
      { id: 2, touched: false },
    ]);
    expect(bustRatingTotalsForRows).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ id: 1, modelId: 10, modelVersionId: 21 }),
    ]);
  });

  it('busts nothing and notifies no one while the post is still scheduled', async () => {
    await insertReviews([[1, 101, SCHEDULED]]);

    await releasePendingReviewsForPosts([SCHEDULED]);

    expect(bustRatingTotalsForRows).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('releases a review only once when the sweep hands its post over again', async () => {
    await insertReviews([[1, 101, LIVE]]);

    await releasePendingReviewsForPosts([LIVE], { onlyUnreleased: true });
    await releasePendingReviewsForPosts([LIVE], { onlyUnreleased: true });

    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('recounts the reviews of an unpublished post without notifying anyone', async () => {
    await pg.exec(`UPDATE "Post" SET "publishedAt" = NULL WHERE id = ${LIVE}`);
    await insertReviews([
      [1, 101, LIVE],
      [2, 102, SCHEDULED],
      [3, 103, null],
    ]);

    const refreshed = await refreshReviewsForUnpublishedPosts([LIVE]);

    expect(refreshed).toEqual([expect.objectContaining({ modelOwnerId: MODEL_OWNER })]);

    const { rows } = await pg.query<{ id: number; touched: boolean }>(
      `SELECT id, "updatedAt" > now() - interval '1 minute' AS touched FROM "ResourceReview" ORDER BY id`
    );
    expect(rows).toEqual([
      { id: 1, touched: true },
      { id: 2, touched: false },
      { id: 3, touched: false },
    ]);
    expect(bustRatingTotalsForRows).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ modelId: 10, modelVersionId: 21 }),
    ]);
    expect(createNotification).not.toHaveBeenCalled();
  });
});
