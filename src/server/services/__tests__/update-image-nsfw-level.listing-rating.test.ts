import { globSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Caches from '~/server/redis/caches';
import type * as ReDerive from '~/server/services/blocks/app-listing-rating-rederive.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';

// Which writes of an image's level reach the store-listing rating re-derive: a moderator's
// own decision does; a user's vote and a Knights consensus do not.

const reDerive = vi.fn<typeof ReDerive.reDeriveListingRatingsForModeratedImage>(async () => []);

vi.mock('~/server/services/blocks/app-listing-rating-rederive.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReDerive>()),
  reDeriveListingRatingsForModeratedImage: (
    ...a: Parameters<typeof ReDerive.reDeriveListingRatingsForModeratedImage>
  ) => reDerive(...a),
}));

vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return {
    ...actual,
    refreshThumbnailCache: vi.fn(() => Promise.resolve()),
    imageMetadataCache: { ...actual.imageMetadataCache, refresh: vi.fn(() => Promise.resolve()) },
  };
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

vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  imagesSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/games/new-order/utils', async (importOriginal) => {
  const reset = { reset: vi.fn(() => Promise.resolve()) };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    poolCounters: {
      Knight: { a: [reset], b: [reset] },
      Templar: { a: [reset], b: [reset] },
    },
  };
});

const { updateImageNsfwLevel } = await import('../image.service');

const IMAGE_ID = 7301;
const MOD = 9001;
const USER = 4242;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.image.findUnique.mockResolvedValue({
    metadata: {},
    postId: null,
    nsfwLevel: NsfwLevel.R,
  } as never);
  // A replica that has not caught up still holds an older level: reading it would be wrong.
  dbMock.dbRead.image.findUnique.mockResolvedValue({
    metadata: {},
    postId: null,
    nsfwLevel: NsfwLevel.X,
  } as never);
  dbMock.dbWrite.image.update.mockResolvedValue({} as never);
});

describe('updateImageNsfwLevel → listing rating re-derive', () => {
  it('a moderator’s re-rate hands the hook the image, its PREVIOUS level and the moderator', async () => {
    const level = await updateImageNsfwLevel({
      id: IMAGE_ID,
      nsfwLevel: NsfwLevel.PG13,
      userId: MOD,
      isModerator: true,
    } as never);

    expect(level).toBe(NsfwLevel.PG13);
    expect(reDerive).toHaveBeenCalledTimes(1);
    expect(reDerive).toHaveBeenCalledWith({
      imageId: IMAGE_ID,
      previousNsfwLevel: NsfwLevel.R,
      actorUserId: MOD,
    });
    // After the image write, so the hook reads the new level.
    expect(dbMock.dbWrite.image.update.mock.invocationCallOrder[0]).toBeLessThan(
      reDerive.mock.invocationCallOrder[0]
    );
  });

  it('a Knights consensus locks through the moderator branch but does not reach the hook', async () => {
    await updateImageNsfwLevel({
      id: IMAGE_ID,
      nsfwLevel: NsfwLevel.PG13,
      userId: MOD,
      isModerator: true,
      activity: 'setNsfwLevelKono',
    } as never);

    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
    expect(reDerive).not.toHaveBeenCalled();
  });

  it('a user’s rating vote does not reach the hook', async () => {
    dbMock.dbWrite.image.findFirst.mockResolvedValue({
      nsfwLevel: NsfwLevel.R,
      userId: USER,
      nsfwLevelLocked: true,
    } as never);

    await updateImageNsfwLevel({
      id: IMAGE_ID,
      nsfwLevel: NsfwLevel.PG13,
      userId: USER,
      isModerator: false,
    } as never);

    expect(reDerive).not.toHaveBeenCalled();
  });
});

describe('who can move a listing rating by re-rating an image', () => {
  it('the hook has exactly one caller: the moderator branch above', () => {
    const root = path.resolve(__dirname, '../../../..');
    const callers = globSync('src/**/*.{ts,tsx}', { cwd: root })
      .map((f) => f.split(path.sep).join('/'))
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => statSync(path.join(root, f)).isFile())
      .filter((f) =>
        readFileSync(path.join(root, f), 'utf8').includes('reDeriveListingRatingsForModeratedImage')
      )
      .sort();

    // The scan pipeline, user votes and owner raises write `Image.nsfwLevel` elsewhere and
    // must not appear here; neither may a second call site appear unreviewed.
    expect(callers).toEqual([
      'src/server/services/blocks/app-listing-rating-rederive.service.ts',
      'src/server/services/image.service.ts',
    ]);
  });
});
