import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
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

const image = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  url: `00000000-0000-0000-0000-0000000000${id}`,
  type: 'image',
  userId: AUTHOR,
  ingestion: 'Scanned',
  nsfwLevel: 1,
  nsfwLevelLocked: false,
  blockedFor: null,
  ...over,
});

const CLEAN = image(10);
const BLOCKED = image(11, { ingestion: 'Blocked', nsfwLevel: 32, blockedFor: 'moderated' });
// A rescan request or a scan error moves `ingestion` off Blocked and leaves the other markers.
const BLOCKED_LEVEL_ONLY = image(12, { ingestion: 'Rescan', nsfwLevel: 32 });
const BLOCK_REASON_ONLY = image(13, { ingestion: 'Error', blockedFor: 'tos' });
const FOREIGN = image(14, { userId: SOMEONE_ELSE });

const ALL = [CLEAN, BLOCKED, BLOCKED_LEVEL_ONLY, BLOCK_REASON_ONLY, FOREIGN];

beforeEach(() => {
  vi.clearAllMocks();
  const article = {
    id: ARTICLE_ID,
    userId: AUTHOR,
    content: '',
    title: 'A title',
    coverId: null,
    status: 'Draft',
    scheduledAt: null,
  };
  dbMock.dbRead.article.findUnique.mockResolvedValue(article as never);
  dbMock.dbWrite.article.findUnique.mockResolvedValue(article as never);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1 as never);
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
  it("re-queues only the author's unblocked images", async () => {
    dbMock.dbRead.imageConnection.findMany.mockResolvedValue(
      ALL.map((img) => ({ imageId: img.id, image: img })) as never
    );

    await rescanArticle({ id: ARTICLE_ID, isModerator: true });

    expect(requeued()).toEqual([CLEAN.id]);
  });
});

describe('rescanArticleImage', () => {
  beforeEach(() => {
    dbMock.dbRead.imageConnection.findFirst.mockResolvedValue({ imageId: 1 } as never);
  });

  it.each([
    ['a blocked image', BLOCKED],
    ['an image that keeps only its Blocked level', BLOCKED_LEVEL_ONLY],
    ['an image that keeps only its block reason', BLOCK_REASON_ONLY],
    ["another owner's image", FOREIGN],
  ])('leaves %s alone', async (_, img) => {
    dbMock.dbRead.image.findUnique.mockResolvedValue(img as never);

    await rescanArticleImage({
      articleId: ARTICLE_ID,
      imageId: img.id,
      userId: AUTHOR,
      isModerator: true,
    });

    expect(requeued()).toEqual([]);
  });

  it("re-queues the author's own unblocked image", async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue(CLEAN as never);

    await rescanArticleImage({
      articleId: ARTICLE_ID,
      imageId: CLEAN.id,
      userId: AUTHOR,
      isModerator: true,
    });

    expect(requeued()).toEqual([CLEAN.id]);
  });
});
