import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as ImageService from '~/server/services/image.service';
import type * as TextScanRoute from '~/server/services/text-scan/route';

// The Redis-backed post-commit helpers never settle without a live Redis, so they are stubbed.
const { enqueueImageIngestion, preventReplicationLag } = vi.hoisted(() => ({
  enqueueImageIngestion: vi.fn(),
  preventReplicationLag: vi.fn(async () => undefined),
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  enqueueImageIngestion,
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  preventReplicationLag,
}));
vi.mock('~/server/services/text-scan/route', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanRoute>()),
  submitTextModerationOrScan: vi.fn(async () => undefined),
}));

import { rescanArticle, rescanArticleImage } from '~/server/services/article.service';

const ARTICLE_ID = 21;
const AUTHOR = 7;
const SOMEONE_ELSE = 8;
const MODERATOR = 99;

type Img = ReturnType<typeof image>;
const image = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  url: `00000000-0000-0000-0000-0000000000${id}`,
  type: 'image',
  userId: AUTHOR,
  ingestion: 'Scanned',
  nsfwLevel: 1,
  nsfwLevelLocked: false,
  blockedFor: null as string | null,
  ...over,
});

const CLEAN = image(10);
// One block marker per image: a scan error or a rescan request can leave either of the last two.
const BLOCKED = image(11, { ingestion: 'Blocked' });
const BLOCKED_LEVEL_ONLY = image(12, { ingestion: 'Rescan', nsfwLevel: 32 });
const BLOCK_REASON_ONLY = image(13, { ingestion: 'Error', blockedFor: 'tos' });
const FOREIGN = image(14, { userId: SOMEONE_ELSE });
const PENDING = image(15, { ingestion: 'Pending' });
const LOCKED = image(16, { nsfwLevelLocked: true });

const SKIPPED: [string, Img][] = [
  ['a blocked image', BLOCKED],
  ['an image that keeps only its Blocked level', BLOCKED_LEVEL_ONLY],
  ['an image that keeps only its block reason', BLOCK_REASON_ONLY],
  ["another owner's image", FOREIGN],
  ['an image still in flight', PENDING],
  ['an image whose rating a moderator locked', LOCKED],
];

/** The columns a Prisma `select` asked for, so a column the code stops selecting reads undefined. */
const pick = (row: Img, select: Record<string, boolean>) =>
  Object.fromEntries(Object.keys(select).map((key) => [key, row[key as keyof Img]]));

const storeArticle = (coverId: number | null) => {
  const article = {
    id: ARTICLE_ID,
    userId: AUTHOR,
    content: '',
    title: 'A title',
    coverId,
    status: 'Draft',
    scheduledAt: null,
  };
  dbMock.dbRead.article.findUnique.mockResolvedValue(article as never);
  dbMock.dbWrite.article.findUnique.mockResolvedValue(article as never);
};

/** A lagging replica: it still holds every image as clean, unblocked and the author's own. */
const stale = (img: Img) => ({
  ...img,
  userId: AUTHOR,
  ingestion: 'Scanned',
  nsfwLevel: 1,
  nsfwLevelLocked: false,
  blockedFor: null,
});

const storeImages = ({ connected = [], byId = [] }: { connected?: Img[]; byId?: Img[] }) => {
  for (const [db, view] of [
    [dbMock.dbWrite, (img: Img) => img],
    [dbMock.dbRead, stale],
  ] as const) {
    db.imageConnection.findMany.mockImplementation((async ({ include }: any) =>
      connected.map((img) => ({
        imageId: img.id,
        image: pick(view(img), include.image.select),
      }))) as never);
    db.image.findUnique.mockImplementation((async ({ where, select }: any) => {
      const img = byId.find((x) => x.id === where.id);
      return img ? pick(view(img), select) : null;
    }) as never);
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  storeArticle(null);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1 as never);
  dbMock.dbRead.imageConnection.findFirst.mockResolvedValue({ imageId: 1 } as never);
});

/** Ids the rescan flipped to Rescan and the ids it sent to scan; both must agree. */
const requeued = () => {
  const flipped = [
    ...dbMock.dbWrite.image.updateMany.mock.calls.flatMap(([arg]) => arg.where.id.in),
    ...dbMock.dbWrite.image.update.mock.calls.map(([arg]) => arg.where.id),
  ];
  const sent = enqueueImageIngestion.mock.calls.flatMap(([arg]) =>
    arg.images.map((img: { id: number }) => img.id)
  );
  expect(sent.sort()).toEqual([...flipped].sort());
  return flipped;
};

describe('rescanArticle', () => {
  it("re-queues only the author's settled, unblocked images", async () => {
    storeImages({ connected: [CLEAN, ...SKIPPED.map(([, img]) => img)] });

    await rescanArticle({ id: ARTICLE_ID, isModerator: true });

    expect(requeued()).toEqual([CLEAN.id]);
  });

  it('re-queues a clean cover that is not among the connected images', async () => {
    const cover = image(17);
    storeArticle(cover.id);
    storeImages({ connected: [CLEAN], byId: [cover] });

    await rescanArticle({ id: ARTICLE_ID, isModerator: true });

    expect(requeued().sort()).toEqual([CLEAN.id, cover.id]);
  });

  it('leaves a blocked cover alone', async () => {
    storeArticle(BLOCKED.id);
    storeImages({ connected: [CLEAN], byId: [BLOCKED] });

    await rescanArticle({ id: ARTICLE_ID, isModerator: true });

    expect(requeued()).toEqual([CLEAN.id]);
  });
});

describe('rescanArticleImage', () => {
  const rescan = (img: Img, userId = AUTHOR) =>
    rescanArticleImage({ articleId: ARTICLE_ID, imageId: img.id, userId, isModerator: true });

  it.each(SKIPPED.filter(([, img]) => img !== PENDING))(
    'refuses %s, so the caller is not told it was sent',
    async (_, img) => {
      storeImages({ byId: [img] });

      await expect(rescan(img)).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      expect(requeued()).toEqual([]);
      // A refusal does not use one of the day's attempts.
      expect(redisMock.redis.packed.set).not.toHaveBeenCalled();
    }
  );

  it('does nothing for an image still in flight', async () => {
    storeImages({ byId: [PENDING] });

    await rescan(PENDING);

    expect(requeued()).toEqual([]);
  });

  it("re-queues the author's own unblocked image", async () => {
    storeImages({ byId: [CLEAN] });

    await rescan(CLEAN);

    expect(requeued()).toEqual([CLEAN.id]);
    expect(redisMock.redis.packed.set).toHaveBeenCalledOnce();
  });

  it("re-queues it for a moderator rescanning someone else's article, under the author", async () => {
    storeImages({ byId: [CLEAN] });

    await rescan(CLEAN, MODERATOR);

    expect(requeued()).toEqual([CLEAN.id]);
    expect(enqueueImageIngestion).toHaveBeenCalledWith(expect.objectContaining({ userId: AUTHOR }));
  });
});
