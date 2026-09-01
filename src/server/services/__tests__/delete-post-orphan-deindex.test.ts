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
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

const POST_ID = 500;
const OWNER_IMAGE = { id: 1, url: 'owner-url', deletable: true };
const FOREIGN_IMAGE = { id: 2, url: 'foreign-url', deletable: false };

// $queryRaw runs select-images, then delete-images (only when something is deletable), then
// delete-post. Branching on that is what lets the all-foreign case be tested at all.
function primeQueries(images: { id: number; url: string; deletable: boolean }[]) {
  const deletable = images.filter((i) => i.deletable);
  dbMock.dbWrite.$queryRaw.mockResolvedValueOnce(images);
  if (deletable.length)
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce(deletable.map(({ id, url }) => ({ id, url })));
  dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([{ id: POST_ID, nsfwLevel: 1 }]);
}

// The scoping predicate is a `Prisma.raw` VALUE in the template, so joining `strings` alone
// renders it as `?` — the one token these assertions are about. Interleave to recover it.
const selectImagesSql = () => {
  const [strings, ...values] = dbMock.dbWrite.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
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

  it('deletes only the poster-owned image, and never the foreign one', async () => {
    primeQueries([OWNER_IMAGE, FOREIGN_IMAGE]);

    await deletePost({ id: POST_ID });

    // The ids arrive as a `Prisma.join` fragment, so they have to be read out of its own `values`.
    const [strings, ...values] = dbMock.dbWrite.$queryRaw.mock.calls[1] as [string[], ...unknown[]];
    const bound = values.flatMap((v) => (v as { values?: unknown[] })?.values ?? [v]);
    expect(strings.join('?')).toContain('DELETE FROM "Image"');
    expect(bound).toContain(OWNER_IMAGE.id);
    expect(bound).not.toContain(FOREIGN_IMAGE.id);

    expect(mockInvalidateManyImageExistence).toHaveBeenCalledWith([OWNER_IMAGE.id]);
    expect(mockDeleteImageFromS3).toHaveBeenCalledTimes(1);
    expect(mockDeleteImageFromS3).toHaveBeenCalledWith({
      id: OWNER_IMAGE.id,
      url: OWNER_IMAGE.url,
    });
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
});
