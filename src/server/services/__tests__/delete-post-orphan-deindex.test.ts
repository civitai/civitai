import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as PromClient from '~/server/prom/client';

// A non-moderator post delete keeps images owned by someone else, and their `postId` is nulled by
// the FK. The image index only selects `postId IS NOT NULL` at build time, so an already-indexed
// doc is never revisited — the feed keeps serving a thumbnail whose detail page is gone.
// Which images the delete takes is decided in SQL: held-owner-delete-paths.behavior.test.ts.

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
const { onStorySparkLost } = vi.hoisted(() => ({
  onStorySparkLost: vi.fn<(id: number) => Promise<void>>(async () => undefined),
}));
vi.mock('~/server/events/points/hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  onStorySparkLost,
}));

const { announceReviewsInBackground } = vi.hoisted(() => ({
  announceReviewsInBackground: vi.fn(),
}));
vi.mock('~/server/services/resourceReview.visibility', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  announceReviewsInBackground,
}));

import { deletePost } from '../post.service';
import { userImageVideoCountCaches } from '~/server/redis/caches';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import { imagesMetricsSearchIndex } from '~/server/search-index';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const POST_ID = 500;
const POSTER_ID = 3307;
const FOREIGN_USER_ID = 4419;
const OWNER_IMAGE = { id: 1, url: 'owner-url', userId: POSTER_ID, deletable: true };
const FOREIGN_IMAGE = { id: 2, url: 'foreign-url', userId: FOREIGN_USER_ID, deletable: false };

// Dispatched on SQL text, not call order: the number of $queryRaw calls ahead of the
// delete is not stable.
const sqlTextOf = (strings: TemplateStringsArray | string[]) => Array.from(strings).join('?');

/** The moderation state the DELETE returns for every deleted image. */
const SCANNED = { ingestion: 'Scanned', needsReview: null, nsfwLevel: 1, blockedFor: null };
const deletedState: {
  ingestion: string;
  needsReview: string | null;
  nsfwLevel: number;
  blockedFor: string | null;
} = { ...SCANNED };

/** `kept`: deletable images the DELETE does not return, as when a hold marker keeps the row. */
function primeQueries(images: (typeof OWNER_IMAGE)[], kept: number[] = []) {
  const deletable = images.filter((i) => i.deletable && !kept.includes(i.id));
  dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = sqlTextOf(strings);
    if (sql.includes('pg_class')) return [{ present: false }];
    // Before the report read below: the DELETE reads "ImageReport" for its child-safety case.
    if (sql.includes('DELETE FROM "Image"'))
      return deletable.map(({ id, url, userId }) => ({
        id,
        url,
        userId,
        ...deletedState,
      }));
    if (sql.includes('DELETE FROM "Post"')) return [{ id: POST_ID, nsfwLevel: 1 }];
    if (sql.includes('"ImageReport"')) return [];
    if (sql.includes('"collectionId"')) return [];
    if (sql.includes('AS deletable')) return images;
    if (sql.includes('SELECT id FROM "Image" WHERE "postId"'))
      return images.map(({ id }) => ({ id }));
    return [];
  });
}

/** The ids sent to the image index for removal, across every call. */
const deindexed = () =>
  [
    ...new Set(
      vi
        .mocked(imagesMetricsSearchIndex.queueUpdate)
        .mock.calls.flatMap(([items]) => items as { id: number; action: string }[])
        .filter((item) => item.action === SearchIndexUpdateQueueAction.Delete)
        .map((item) => item.id)
    ),
  ].sort((a, b) => a - b);

/** The images whose existence cache was set to gone. */
const existenceBusted = () =>
  vi
    .mocked(redisMock.sysRedis.packed.set)
    .mock.calls.map(([key]) => String(key))
    .filter((key) => key.startsWith(`${REDIS_SYS_KEYS.CACHES.IMAGE_EXISTS}:`))
    .map((key) => Number(key.split(':').pop()));

const callContaining = (needle: string) =>
  dbMock.dbWrite.$queryRaw.mock.calls.find(([strings]: [string[]]) =>
    sqlTextOf(strings).includes(needle)
  ) as [string[], ...unknown[]];

describe('deletePost orphan de-indexing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbWrite.$transaction.mockImplementation(async (fn: any) => fn(dbMock.dbWrite));
    vi.spyOn(userImageVideoCountCaches, 'bust').mockResolvedValue(undefined);
    vi.spyOn(imagesMetricsSearchIndex, 'queueUpdate').mockResolvedValue(undefined as never);
  });

  it('takes back the event points of a story started from an image, when the post was its chapter 1', async () => {
    primeQueries([OWNER_IMAGE]);
    dbMock.dbWrite.storylineChapter.findFirst.mockResolvedValueOnce({ storylineId: 9 } as never);
    await deletePost({ id: POST_ID, actor: { system: 'test' } });
    expect(dbMock.dbWrite.storylineChapter.findFirst).toHaveBeenCalledWith({
      where: { postId: POST_ID, depth: 0, storyline: { sparkImageId: { not: null } } },
      select: { storylineId: true },
    });
    expect(onStorySparkLost).toHaveBeenCalledWith(9);
  });

  it('announces the unreleased reviews written from the post, read before the post goes', async () => {
    primeQueries([OWNER_IMAGE]);
    const base = dbMock.dbWrite.$queryRaw.getMockImplementation()!;
    dbMock.dbWrite.$queryRaw.mockImplementation(((strings: TemplateStringsArray) =>
      sqlTextOf(strings).includes('"releasedAt" IS NULL')
        ? Promise.resolve([{ id: 77 }])
        : base(strings)) as never);

    await deletePost({ id: POST_ID, actor: { system: 'test' } });

    expect(announceReviewsInBackground).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reviewIds: [77] })
    );
    const { calls, invocationCallOrder } = dbMock.dbWrite.$queryRaw.mock;
    const order = (needle: string) =>
      invocationCallOrder[
        calls.findIndex((call) => sqlTextOf(call[0] as string[]).includes(needle))
      ];
    expect(order('"releasedAt" IS NULL')).toBeLessThan(order('DELETE FROM "Post"'));
  });

  it('touches no event points for a post that starts no story', async () => {
    primeQueries([OWNER_IMAGE]);
    await deletePost({ id: POST_ID, actor: { system: 'test' } });
    expect(onStorySparkLost).not.toHaveBeenCalled();
  });

  it('lets a moderator take every image', async () => {
    primeQueries([
      { ...OWNER_IMAGE, deletable: true },
      { ...FOREIGN_IMAGE, deletable: true },
    ]);

    await deletePost({ id: POST_ID, isModerator: true, actor: { system: 'test' } });

    expect(deindexed()).toEqual([OWNER_IMAGE.id, FOREIGN_IMAGE.id]);
    expect(callContaining('DELETE FROM "Image"')[1]).toEqual([OWNER_IMAGE.id, FOREIGN_IMAGE.id]);
  });

  it('de-indexes the surviving foreign image and a kept image, as well as the deleted one', async () => {
    const KEPT = { id: 9, url: 'kept-url', userId: POSTER_ID, deletable: true };
    primeQueries([OWNER_IMAGE, KEPT, FOREIGN_IMAGE], [KEPT.id]);

    await deletePost({ id: POST_ID, actor: { system: 'test' } });

    // Removals only, not just the ids: `Update` never revisits an orphan (the index build requires
    // `postId IS NOT NULL`), so that slip reproduces the original bug verbatim.
    expect(deindexed()).toEqual([OWNER_IMAGE.id, FOREIGN_IMAGE.id, KEPT.id]);
    expect(existenceBusted()).toEqual([OWNER_IMAGE.id]);
  });

  // Orphaned images leave the count too: a NULL `postId` fails the count query's `NOT IN`.
  it("busts the image count of every image's owner, including orphaned ones", async () => {
    primeQueries([OWNER_IMAGE, FOREIGN_IMAGE]);

    await deletePost({ id: POST_ID, actor: { system: 'test' } });

    expect(userImageVideoCountCaches.bust).toHaveBeenCalledWith([POSTER_ID, FOREIGN_USER_ID]);
  });
});
