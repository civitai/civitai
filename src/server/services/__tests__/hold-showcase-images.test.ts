import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { REDIS_KEYS } from '~/server/redis/client';
import { TokenScope } from '~/shared/constants/token-scope.constants';
// Static, so the large module graph loads at collection rather than inside one test's timeout.
import {
  getHeldLevelsByPost,
  heldGalleryViewer,
  holdShowcaseImages,
} from '~/server/services/model.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn().mockResolvedValue(false) }));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbWrite: {}, pgDbReadLong: {} }));

const HELD_MODEL = 5;
const OPEN_MODEL = 6;
const OWNER = 50;
const HELD_VERSION = 10;
const OPEN_VERSION = 20;
const SFW = NsfwLevel.PG | NsfwLevel.PG13;

/** Gallery settings as cached: the held model serves PG and PG13; the other is not held. */
function cacheGalleries() {
  redisMock.redis.mGet.mockImplementation(async (keys: string[]) =>
    keys.map((key) => {
      const id = Number(key.slice(`${REDIS_KEYS.MODEL.GALLERY_SETTINGS}:`.length));
      return id === HELD_MODEL
        ? JSON.stringify({ level: SFW, hiddenTags: [], hiddenUsers: [], sfwHeld: true })
        : JSON.stringify({ none: true });
    })
  );
}

const image = (id: number, nsfwLevel: number) => ({ id, nsfwLevel });
const byVersion = () => ({
  [HELD_VERSION]: {
    modelVersionId: HELD_VERSION,
    images: [image(1, NsfwLevel.X), image(2, NsfwLevel.PG), image(3, NsfwLevel.R)],
  },
  [OPEN_VERSION]: {
    modelVersionId: OPEN_VERSION,
    images: [image(4, NsfwLevel.X), image(5, NsfwLevel.PG)],
  },
});
const models = new Map([
  [HELD_VERSION, { modelId: HELD_MODEL, ownerId: OWNER }],
  [OPEN_VERSION, { modelId: OPEN_MODEL, ownerId: 60 }],
]);
const ids = (entry: { images: { id: number }[] } | undefined) => entry?.images.map((i) => i.id);

beforeEach(() => {
  vi.clearAllMocks();
  cacheGalleries();
});

describe('holdShowcaseImages', () => {
  it("serves a held model's showcase only within its held level, and leaves others whole", async () => {
    const held = await holdShowcaseImages(byVersion(), { models });
    expect(ids(held[HELD_VERSION])).toEqual([2]);
    expect(ids(held[OPEN_VERSION])).toEqual([4, 5]);
  });

  it('never changes the entries it was given: they can be the shared cache', async () => {
    const input = byVersion();
    await holdShowcaseImages(input, { models });
    expect(ids(input[HELD_VERSION])).toEqual([1, 2, 3]);
  });

  it("shows the model's owner and moderators the whole showcase", async () => {
    const owner = await holdShowcaseImages(byVersion(), {
      models,
      viewer: { id: OWNER, isModerator: false },
    });
    expect(ids(owner[HELD_VERSION])).toEqual([1, 2, 3]);
    const moderator = await holdShowcaseImages(byVersion(), {
      models,
      viewer: { id: 99, isModerator: true },
    });
    expect(ids(moderator[HELD_VERSION])).toEqual([1, 2, 3]);
    const other = await holdShowcaseImages(byVersion(), {
      models,
      viewer: { id: 99, isModerator: false },
    });
    expect(ids(other[HELD_VERSION])).toEqual([2]);
  });

  it("looks up the owner when the caller does not know it, and holds anyone who isn't", async () => {
    dbMock.dbRead.model.findMany.mockResolvedValue([{ id: HELD_MODEL, userId: OWNER }]);
    const unowned = new Map([[HELD_VERSION, { modelId: HELD_MODEL }]]);
    const owner = await holdShowcaseImages(
      { [HELD_VERSION]: byVersion()[HELD_VERSION] },
      { models: unowned, viewer: { id: OWNER, isModerator: false } }
    );
    expect(ids(owner[HELD_VERSION])).toEqual([1, 2, 3]);
    const other = await holdShowcaseImages(
      { [HELD_VERSION]: byVersion()[HELD_VERSION] },
      { models: unowned, viewer: { id: 99, isModerator: false } }
    );
    expect(ids(other[HELD_VERSION])).toEqual([2]);
  });

  const uncached = (flags: { minor: boolean; sfwOnly: boolean }) => {
    const row = { id: HELD_MODEL, userId: OWNER, gallerySettings: null, ...flags };
    dbMock.dbRead.model.findFirst.mockResolvedValue(row);
    dbMock.dbWrite.model.findFirst.mockResolvedValue(row);
    return holdShowcaseImages(
      { [HELD_VERSION]: byVersion()[HELD_VERSION] },
      { models: new Map([[HELD_VERSION, { modelId: HELD_MODEL }]]) }
    ).then((held) => ids(held[HELD_VERSION]));
  };

  it.each([
    ['minor', { minor: true, sfwOnly: false }],
    ['SFW-only', { minor: false, sfwOnly: true }],
  ])('holds a %s model whose gallery settings are not cached yet', async (_, flags) => {
    redisMock.redis.mGet.mockResolvedValue([null]);
    expect(await uncached(flags)).toEqual([2]);
  });

  it('leaves an unflagged model whole when its settings are not cached yet', async () => {
    redisMock.redis.mGet.mockResolvedValue([null]);
    expect(await uncached({ minor: false, sfwOnly: false })).toEqual([1, 2, 3]);
  });

  it('still holds the model when the batched settings read fails', async () => {
    redisMock.redis.mGet.mockRejectedValue(new Error('redis down'));
    expect(await uncached({ minor: true, sfwOnly: false })).toEqual([2]);
  });

  const missThenFail = () => {
    redisMock.redis.mGet.mockResolvedValue([null]);
    redisMock.redis.get.mockRejectedValue(new Error('redis down'));
  };
  const openShowcase = () => ({
    [OPEN_VERSION]: {
      modelVersionId: OPEN_VERSION,
      images: [image(1, NsfwLevel.X), image(2, NsfwLevel.PG), image(3, NsfwLevel.PG13)],
    },
  });
  const openModels = new Map([[OPEN_VERSION, { modelId: OPEN_MODEL }]]);

  it('serves PG only for a model whose own settings read fails after a cache miss', async () => {
    missThenFail();
    const held = await holdShowcaseImages(openShowcase(), { models: openModels });
    expect(ids(held[OPEN_VERSION])).toEqual([2]);
  });

  it("fails a caller that stores its result when a model's own settings read fails", async () => {
    missThenFail();
    await expect(
      holdShowcaseImages(openShowcase(), { models: openModels, onReadFailure: 'throw' })
    ).rejects.toThrow('redis down');
  });

  it('serves PG only for the whole batch without reading each model again when the batched read fails', async () => {
    redisMock.redis.mGet.mockRejectedValue(new Error('redis slow'));
    const held = await holdShowcaseImages(
      {
        [OPEN_VERSION]: {
          modelVersionId: OPEN_VERSION,
          images: [image(1, NsfwLevel.X), image(2, NsfwLevel.PG), image(3, NsfwLevel.PG13)],
        },
      },
      { models: new Map([[OPEN_VERSION, { modelId: OPEN_MODEL }]]) }
    );
    expect(ids(held[OPEN_VERSION])).toEqual([2]);
    expect(redisMock.redis.get).not.toHaveBeenCalled();
  });

  it('serves only PG images, without failing, when no settings read succeeds', async () => {
    redisMock.redis.mGet.mockRejectedValue(new Error('redis down'));
    redisMock.redis.get.mockRejectedValue(new Error('redis down'));
    const held = await holdShowcaseImages(
      {
        [OPEN_VERSION]: {
          modelVersionId: OPEN_VERSION,
          images: [image(1, NsfwLevel.X), image(2, NsfwLevel.PG), image(3, NsfwLevel.PG13)],
        },
      },
      { models: new Map([[OPEN_VERSION, { modelId: OPEN_MODEL }]]) }
    );
    expect(ids(held[OPEN_VERSION])).toEqual([2]);
  });
});

describe('holdShowcaseImages for a caller that stores its result', () => {
  it('fails rather than serve PG only when no settings read succeeds', async () => {
    redisMock.redis.mGet.mockRejectedValue(new Error('redis down'));
    redisMock.redis.get.mockRejectedValue(new Error('redis down'));
    await expect(
      holdShowcaseImages(
        { [OPEN_VERSION]: byVersion()[OPEN_VERSION] },
        { models: new Map([[OPEN_VERSION, { modelId: OPEN_MODEL }]]), onReadFailure: 'throw' }
      )
    ).rejects.toThrow('redis down');
  });
});

describe('getHeldLevelsByPost', () => {
  it('fails rather than guess a level when the gallery settings cannot be read', async () => {
    // Only the gallery settings reads fail; the post and version lookups still resolve.
    const settingsKey = /^model:gallery-settings:\d+$/;
    redisMock.redis.mGet.mockImplementation(async (keys: string[]) => {
      if (keys.some((key) => settingsKey.test(key))) throw new Error('redis down');
      return keys.map(() => null);
    });
    redisMock.redis.get.mockImplementation(async (key: string) => {
      if (settingsKey.test(key)) throw new Error('redis down');
      return null;
    });
    dbMock.dbRead.post.findMany.mockResolvedValue([{ id: 1, modelVersionId: HELD_VERSION }]);
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([
      { id: HELD_VERSION, modelId: HELD_MODEL },
    ]);
    await expect(getHeldLevelsByPost([1])).rejects.toThrow('redis down');
  });
});

describe('holdShowcaseImages on a version it cannot place', () => {
  it('serves none of its images until the version can be found on a model', async () => {
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([]);
    const held = await holdShowcaseImages({ [HELD_VERSION]: byVersion()[HELD_VERSION] });
    expect(ids(held[HELD_VERSION])).toEqual([]);
  });

  it('places a version through its model when the caller does not say', async () => {
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([
      { id: HELD_VERSION, modelId: HELD_MODEL },
    ]);
    const held = await holdShowcaseImages({ [HELD_VERSION]: byVersion()[HELD_VERSION] });
    expect(ids(held[HELD_VERSION])).toEqual([2]);
  });
});

describe('heldGalleryViewer', () => {
  const user = { id: OWNER, isModerator: true };

  it('exempts a signed-in session', () => {
    expect(heldGalleryViewer({ user })).toEqual({ id: OWNER, isModerator: true });
  });

  it('exempts a full-access key', () => {
    expect(
      heldGalleryViewer({
        user,
        apiKeyId: 1,
        apiKeyType: 'User',
        subject: { type: 'apiKey' },
        tokenScope: TokenScope.Full,
      } as never)
    ).toEqual({ id: OWNER, isModerator: true });
  });

  it('holds an OAuth app or a scoped key acting for the owner or a moderator', () => {
    expect(heldGalleryViewer({ user, subject: 'app' } as never)).toBeUndefined();
    expect(
      heldGalleryViewer({ user, apiKeyId: 1, apiKeyType: 'User', tokenScope: 1 } as never)
    ).toBeUndefined();
  });

  it('holds a signed-out viewer', () => {
    expect(heldGalleryViewer({ user: undefined })).toBeUndefined();
  });
});
