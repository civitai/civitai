import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as PromClient from '~/server/prom/client';
import type * as ImageService from '~/server/services/image.service';

// A non-moderator post delete keeps images owned by someone else, and their `postId` is nulled by
// the FK. The image index only selects `postId IS NOT NULL` at build time, so an already-indexed
// doc is never revisited — the feed keeps serving a thumbnail whose detail page is gone.
//
// This is the only deletePost coverage in the suite; inverting the `deletable` filter deletes the
// other user's images, and nothing else would print.

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

const { mockQueueImageSearchIndexUpdate, mockInvalidateManyImageExistence, mockDeleteImageFromS3 } =
  vi.hoisted(() => ({
    mockQueueImageSearchIndexUpdate: vi.fn(),
    mockInvalidateManyImageExistence: vi.fn(),
    mockDeleteImageFromS3: vi.fn(),
  }));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  queueImageSearchIndexUpdate: mockQueueImageSearchIndexUpdate,
  invalidateManyImageExistence: mockInvalidateManyImageExistence,
  deleteImageFromS3: mockDeleteImageFromS3,
}));

import { deletePost } from '../post.service';
import { userImageVideoCountCaches } from '~/server/redis/caches';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

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
function primeQueries(
  images: (typeof OWNER_IMAGE)[],
  kept: number[] = [],
  reported: number[] = []
) {
  const deletable = images.filter((i) => i.deletable && !kept.includes(i.id));
  dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = sqlTextOf(strings);
    if (sql.includes('pg_class')) return [{ present: false }];
    if (sql.includes('"ImageReport"')) return reported.map((imageId) => ({ imageId }));
    if (sql.includes('"collectionId"')) return [];
    if (sql.includes('DELETE FROM "Image"'))
      return deletable.map(({ id, url, userId }) => ({
        id,
        url,
        userId,
        ...deletedState,
      }));
    if (sql.includes('DELETE FROM "Post"')) return [{ id: POST_ID, nsfwLevel: 1 }];
    if (sql.includes('AS deletable')) return images;
    return [];
  });
}

const callContaining = (needle: string) =>
  dbMock.dbWrite.$queryRaw.mock.calls.find(([strings]: [string[]]) =>
    sqlTextOf(strings).includes(needle)
  ) as [string[], ...unknown[]];

// The scoping predicate is a `Prisma.raw` VALUE in the template, so joining `strings` alone
// renders it as `?` — the one token these assertions are about. Interleave to recover it.
const selectImagesSql = () => {
  const [strings, ...values] = callContaining('AS deletable');
  return strings
    .map((chunk, i) => {
      if (i === 0) return chunk;
      const value = values[i - 1] as { sql?: string } | undefined;
      return (typeof value?.sql === 'string' ? value.sql : '?') + chunk;
    })
    .join('');
};

describe('deletePost orphan de-indexing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbWrite.$transaction.mockImplementation(async (fn: any) => fn(dbMock.dbWrite));
    vi.spyOn(userImageVideoCountCaches, 'bust').mockResolvedValue(undefined);
  });

  it('scopes the delete to poster-owned images in SQL', async () => {
    primeQueries([OWNER_IMAGE, FOREIGN_IMAGE]);

    await deletePost({ id: POST_ID });

    // The faked rows carry `deletable` already, so without this the SQL expression that DERIVES it
    // is never observed — inverting it to `!=` would delete the other user's images silently.
    expect(selectImagesSql()).toContain('i."userId" = p."userId"');
  });

  it('lets a moderator take every image', async () => {
    primeQueries([
      { ...OWNER_IMAGE, deletable: true },
      { ...FOREIGN_IMAGE, deletable: true },
    ]);

    await deletePost({ id: POST_ID, isModerator: true });

    expect(selectImagesSql()).toContain('TRUE AS deletable');
    expect(mockQueueImageSearchIndexUpdate).toHaveBeenCalledWith({
      ids: [OWNER_IMAGE.id, FOREIGN_IMAGE.id],
      action: SearchIndexUpdateQueueAction.Delete,
    });
    expect(mockDeleteImageFromS3).toHaveBeenCalledTimes(2);
  });

  it('de-indexes the surviving foreign image as well as the deleted one', async () => {
    primeQueries([OWNER_IMAGE, FOREIGN_IMAGE]);

    await deletePost({ id: POST_ID });

    // The action is asserted, not just the ids: `Update` never revisits an orphan (the index build
    // requires `postId IS NOT NULL`), so that slip reproduces the original bug verbatim.
    expect(mockQueueImageSearchIndexUpdate).toHaveBeenCalledWith({
      ids: [OWNER_IMAGE.id, FOREIGN_IMAGE.id],
      action: SearchIndexUpdateQueueAction.Delete,
    });
  });

  it('drops a deletable image the delete kept from search, and never deletes its file', async () => {
    primeQueries([OWNER_IMAGE, { ...FOREIGN_IMAGE, deletable: true }], [FOREIGN_IMAGE.id]);

    await deletePost({ id: POST_ID, isModerator: true });

    expect(mockQueueImageSearchIndexUpdate).toHaveBeenCalledWith({
      ids: [OWNER_IMAGE.id, FOREIGN_IMAGE.id],
      action: SearchIndexUpdateQueueAction.Delete,
    });
    expect(mockDeleteImageFromS3).toHaveBeenCalledTimes(1);
    expect(mockInvalidateManyImageExistence).toHaveBeenCalledWith([OWNER_IMAGE.id]);
  });

  it('returns the ids of the images it deleted, and only those', async () => {
    primeQueries([OWNER_IMAGE, FOREIGN_IMAGE]);

    const result = await deletePost({ id: POST_ID });

    expect(result?.deletedImageIds).toEqual([OWNER_IMAGE.id]);
  });

  it('deletes only the poster-owned image, and never the foreign one', async () => {
    primeQueries([OWNER_IMAGE, FOREIGN_IMAGE]);

    await deletePost({ id: POST_ID });

    // The ids arrive as a `Prisma.join` fragment, so they have to be read out of its own `values`.
    const [strings, ...values] = callContaining('DELETE FROM "Image"');
    const bound = values.flatMap((v) => (v as { values?: unknown[] })?.values ?? [v]);
    expect(strings.join('?')).toContain('DELETE FROM "Image"');
    expect(bound).toContain(OWNER_IMAGE.id);
    expect(bound).not.toContain(FOREIGN_IMAGE.id);

    expect(mockInvalidateManyImageExistence).toHaveBeenCalledWith([OWNER_IMAGE.id]);
    expect(mockDeleteImageFromS3).toHaveBeenCalledTimes(1);
    expect(mockDeleteImageFromS3).toHaveBeenCalledWith({
      id: OWNER_IMAGE.id,
      url: OWNER_IMAGE.url,
      keepShopArtwork: false,
    });
  });

  // Only then may the storage delete keep an object that shop artwork still uses.
  it.each([
    ['the poster deletes it', POSTER_ID, {}, true],
    ['someone else deletes it', 99, {}, false],
    ['it is blocked', POSTER_ID, { ingestion: 'Blocked' }, false],
    ['it keeps a block reason', POSTER_ID, { ingestion: 'Error', blockedFor: 'tos' }, false],
    ['it is not scanned yet', POSTER_ID, { ingestion: 'Pending' }, false],
    ['it is held for review', POSTER_ID, { needsReview: 'csam' }, false],
  ] as const)(
    'asks to keep shop artwork only for a plain owner delete: %s',
    async (_case, deletedById, state, keep) => {
      Object.assign(deletedState, SCANNED, state);
      primeQueries([OWNER_IMAGE]);

      await deletePost({ id: POST_ID, deletedById });

      expect(mockDeleteImageFromS3).toHaveBeenCalledWith(
        expect.objectContaining({ id: OWNER_IMAGE.id, keepShopArtwork: keep })
      );
      Object.assign(deletedState, SCANNED);
    }
  );

  // The report links cascade with the rows, so the lookup must see every deletable image before the delete.
  it('looks up reports for the deletable images before deleting them, and keeps per image', async () => {
    const SECOND = { id: 9, url: 'second-url', userId: POSTER_ID, deletable: true };
    primeQueries([OWNER_IMAGE, SECOND, FOREIGN_IMAGE], [], [SECOND.id]);

    await deletePost({ id: POST_ID, deletedById: POSTER_ID });

    const calls = dbMock.dbWrite.$queryRaw.mock.calls as [string[], ...unknown[]][];
    const order = dbMock.dbWrite.$queryRaw.mock.invocationCallOrder;
    const at = (needle: string) =>
      calls.findIndex(([strings]) => sqlTextOf(strings).includes(needle));
    const reportCall = at('"ImageReport"');
    expect(reportCall).toBeGreaterThanOrEqual(0);
    expect(calls[reportCall].slice(1)).toContainEqual([OWNER_IMAGE.id, SECOND.id]);
    expect(order[reportCall]).toBeLessThan(order[at('DELETE FROM "Image"')]);
    expect(mockDeleteImageFromS3).toHaveBeenCalledWith(
      expect.objectContaining({ id: OWNER_IMAGE.id, keepShopArtwork: true })
    );
    expect(mockDeleteImageFromS3).toHaveBeenCalledWith(
      expect.objectContaining({ id: SECOND.id, keepShopArtwork: false })
    );
  });

  it('does not ask to keep shop artwork for an image under an open report', async () => {
    primeQueries([OWNER_IMAGE], [], [OWNER_IMAGE.id]);

    await deletePost({ id: POST_ID, deletedById: POSTER_ID });

    expect(mockDeleteImageFromS3).toHaveBeenCalledWith(
      expect.objectContaining({ id: OWNER_IMAGE.id, keepShopArtwork: false })
    );
  });

  it('de-indexes without deleting when every image is someone else’s', async () => {
    primeQueries([FOREIGN_IMAGE]);

    await deletePost({ id: POST_ID });

    expect(mockQueueImageSearchIndexUpdate).toHaveBeenCalledWith({
      ids: [FOREIGN_IMAGE.id],
      action: SearchIndexUpdateQueueAction.Delete,
    });
    expect(mockDeleteImageFromS3).not.toHaveBeenCalled();
    expect(mockInvalidateManyImageExistence).not.toHaveBeenCalled();
  });

  // Orphaned images leave the count too: a NULL `postId` fails the count query's `NOT IN`.
  it("busts the image count of every image's owner, including orphaned ones", async () => {
    primeQueries([OWNER_IMAGE, FOREIGN_IMAGE]);

    await deletePost({ id: POST_ID });

    expect(selectImagesSql()).toContain('i."userId"');
    expect(userImageVideoCountCaches.bust).toHaveBeenCalledTimes(1);
    expect(userImageVideoCountCaches.bust).toHaveBeenCalledWith([POSTER_ID, FOREIGN_USER_ID]);
  });
});
