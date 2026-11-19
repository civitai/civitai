import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { childBrowsingTagIds } from '@civitai/shared';
import { NsfwLevel } from '~/server/common/enums';
import type * as RedisCaches from '~/server/redis/caches';
import type * as CollectionService from '~/server/services/collection.service';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

const { mockGetAllCollections } = vi.hoisted(() => ({ mockGetAllCollections: vi.fn() }));

vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getAllCollections: mockGetAllCollections,
  getCollectionItemCount: vi.fn().mockResolvedValue([]),
  getContributorCount: vi.fn().mockResolvedValue([]),
}));

vi.mock('~/server/services/collection-cover-visibility', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withServableCovers: async <T>(rows: T[]) => rows,
}));

const { mockTagIdsFetch } = vi.hoisted(() => ({ mockTagIdsFetch: vi.fn() }));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  tagIdsForImagesCache: { fetch: mockTagIdsFetch },
}));

const { mockImageTagRows } = vi.hoisted(() => ({ mockImageTagRows: vi.fn() }));
vi.mock('~/server/redis/image-tag-rows', () => ({ getImageTagRows: mockImageTagRows }));

vi.mock('~/server/services/system-cache', async (importOriginal) => {
  const { DEFAULT_BROWSING_SETTINGS_ADDONS } = await import(
    '~/shared/constants/browsing-settings-addons'
  );
  return {
    ...(await importOriginal<object>()),
    getBlockedBrowsingTags: vi.fn(async () => []),
    getBrowsingSettingAddons: vi.fn(async () => DEFAULT_BROWSING_SETTINGS_ADDONS),
  };
});

import { getAllCollectionsInfiniteHandler } from '../collection.controller';

const ownCover = (id: number, nsfwLevel: number, extra: object = {}) => ({
  id,
  userId: 1,
  name: `c${id}`,
  metadata: {},
  image: { id: 100 + id, url: `own-${id}`, nsfwLevel, meta: null, tags: [], ...extra },
});
const noCover = (id: number) => ({ ...ownCover(id, 1), image: null });
const itemCover = (collectionId: number, imageId: number, nsfwLevel: number, extra = {}) => ({
  id: collectionId,
  image: { id: imageId, url: `item-${imageId}`, nsfwLevel, ...extra },
  src: null,
});

const SIGNED_OUT = { user: undefined, features: { canViewNsfw: true }, req: { headers: {} } };
const MATURE_VIEWER = {
  user: { id: 9, isModerator: false, showNsfw: true, browsingLevel: allBrowsingLevelsFlag },
  features: { canViewNsfw: true },
  req: { headers: {} },
};
const GREEN_MATURE_VIEWER = {
  ...MATURE_VIEWER,
  features: { canViewNsfw: false, isGreen: true },
};

function itemCovers(rows: ReturnType<typeof itemCover>[]) {
  dbMock.dbRead.$queryRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const bound = Prisma.sql(strings, ...(values as never[])).values;
      return rows.filter((row) => bound.includes(row.id));
    }
  );
}

async function feed(ctx: object, browsingLevel?: number) {
  const { items } = await getAllCollectionsInfiniteHandler({
    input: { limit: 10, browsingLevel } as never,
    ctx: ctx as never,
  });
  return items.map((i) => ({
    id: i.id,
    own: i.image?.id ?? null,
    items: i.images.map((img) => img.id),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTagIdsFetch.mockResolvedValue({});
  mockImageTagRows.mockResolvedValue([]);
  mockGetAllCollections.mockResolvedValue([
    ownCover(1, NsfwLevel.PG),
    ownCover(2, NsfwLevel.XXX),
    noCover(3),
  ]);
  itemCovers([
    itemCover(2, 200, NsfwLevel.PG),
    itemCover(3, 300, NsfwLevel.PG),
    itemCover(3, 301, NsfwLevel.X),
    itemCover(3, 302, NsfwLevel.R),
  ]);
});

describe('getAllCollectionsInfiniteHandler cover levels', () => {
  it('serves a signed-out viewer only PG covers, whatever level the request asks for', async () => {
    expect(await feed(SIGNED_OUT, allBrowsingLevelsFlag)).toEqual([
      { id: 1, own: 101, items: [] },
      { id: 2, own: null, items: [200] },
      { id: 3, own: null, items: [300] },
    ]);
  });

  it('serves a mature signed-in viewer their mature covers (control)', async () => {
    expect(await feed(MATURE_VIEWER)).toEqual([
      { id: 1, own: 101, items: [] },
      { id: 2, own: 102, items: [] },
      { id: 3, own: null, items: [300, 301, 302] },
    ]);
  });

  it('holds a mature signed-in viewer to the SFW cap on the green domain', async () => {
    expect(await feed(GREEN_MATURE_VIEWER)).toEqual([
      { id: 1, own: 101, items: [] },
      { id: 2, own: null, items: [200] },
      { id: 3, own: null, items: [300] },
    ]);
  });

  it('serves a signed-in viewer only the levels they browse', async () => {
    expect(await feed(MATURE_VIEWER, sfwBrowsingLevelsFlag)).toEqual([
      { id: 1, own: 101, items: [] },
      { id: 2, own: null, items: [200] },
      { id: 3, own: null, items: [300] },
    ]);
  });

  it('falls back to PG when neither the request nor the viewer names a level', async () => {
    const noLevel = { ...MATURE_VIEWER, user: { id: 9, isModerator: false } };
    expect(await feed(noLevel)).toEqual([
      { id: 1, own: 101, items: [] },
      { id: 2, own: null, items: [200] },
      { id: 3, own: null, items: [300] },
    ]);
  });

  it('reads the ToS flag of each own cover', async () => {
    await feed(MATURE_VIEWER);
    expect(mockGetAllCollections).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          image: { select: expect.objectContaining({ tosViolation: true }) },
        }),
      })
    );
  });

  it('never serves an unrated cover', async () => {
    mockGetAllCollections.mockResolvedValue([ownCover(1, 0), noCover(3)]);
    itemCovers([itemCover(1, 100, NsfwLevel.PG), itemCover(3, 300, 0)]);
    expect(await feed(MATURE_VIEWER)).toEqual([
      { id: 1, own: null, items: [100] },
      { id: 3, own: null, items: [] },
    ]);
  });

  it("drops the owner's own unscanned cover and falls back to item covers", async () => {
    const owner = { ...MATURE_VIEWER, user: { ...MATURE_VIEWER.user, id: 1 } };
    mockGetAllCollections.mockResolvedValue([ownCover(1, 0)]);
    itemCovers([itemCover(1, 100, NsfwLevel.PG)]);
    expect(await feed(owner)).toEqual([{ id: 1, own: null, items: [100] }]);
  });

  it('returns no ToS flag on a served cover', async () => {
    mockGetAllCollections.mockResolvedValue([
      ownCover(1, NsfwLevel.PG, { tosViolation: false }),
      noCover(3),
    ]);
    itemCovers([itemCover(3, 300, NsfwLevel.PG, { tosViolation: false })]);
    const { items } = await getAllCollectionsInfiniteHandler({
      input: { limit: 10 } as never,
      ctx: MATURE_VIEWER as never,
    });
    expect(items[0].image).not.toHaveProperty('tosViolation');
    expect(items[1].images[0]).not.toHaveProperty('tosViolation');
    expect(items[0].image?.id).toBe(101);
    expect(items[1].images[0]?.id).toBe(300);
  });

  it('never serves a Blocked-level or ToS-violating cover, even to a viewer at every level', async () => {
    mockGetAllCollections.mockResolvedValue([
      ownCover(1, NsfwLevel.Blocked),
      ownCover(2, NsfwLevel.PG, { tosViolation: true }),
      noCover(3),
    ]);
    itemCovers([
      itemCover(3, 300, NsfwLevel.PG),
      itemCover(3, 301, NsfwLevel.Blocked),
      itemCover(3, 302, NsfwLevel.PG, { tosViolation: true }),
    ]);
    expect(await feed(MATURE_VIEWER, allBrowsingLevelsFlag | NsfwLevel.Blocked)).toEqual([
      { id: 1, own: null, items: [] },
      { id: 2, own: null, items: [] },
      { id: 3, own: null, items: [300] },
    ]);
  });
});

describe('getAllCollectionsInfiniteHandler browsing-tag rules', () => {
  const CHILD_TAG = childBrowsingTagIds[0];
  const OTHER_TAG = 999001;
  const MOD_VIEWER = { ...MATURE_VIEWER, user: { ...MATURE_VIEWER.user, isModerator: true } };

  beforeEach(() => {
    mockGetAllCollections.mockResolvedValue([
      ownCover(1, NsfwLevel.R, { userId: 5, tags: [{ tag: { id: CHILD_TAG } }] }),
      ownCover(2, NsfwLevel.R, { userId: 5, tags: [{ tag: { id: OTHER_TAG } }] }),
      noCover(3),
    ]);
    itemCovers([
      itemCover(1, 400, NsfwLevel.PG, { userId: 5 }),
      itemCover(3, 300, NsfwLevel.R, { userId: 5 }),
      itemCover(3, 301, NsfwLevel.R, { userId: 5 }),
    ]);
    mockTagIdsFetch.mockResolvedValue({
      300: { imageId: 300, tags: [CHILD_TAG] },
      301: { imageId: 301, tags: [OTHER_TAG] },
    });
  });

  it('drops a child-tagged image for a mature non-moderator, keeping other mature images', async () => {
    expect(await feed(MATURE_VIEWER)).toEqual([
      { id: 1, own: null, items: [400] },
      { id: 2, own: 102, items: [] },
      { id: 3, own: null, items: [301] },
    ]);
  });

  it('drops a child-tagged image above PG-13 even for a moderator, who skips the addon rules', async () => {
    expect(await feed(MOD_VIEWER)).toEqual([
      { id: 1, own: null, items: [400] },
      { id: 2, own: 102, items: [] },
      { id: 3, own: null, items: [301] },
    ]);
  });

  it('drops a POI or minor-flagged image for a mature non-moderator', async () => {
    mockGetAllCollections.mockResolvedValue([
      ownCover(1, NsfwLevel.R, { userId: 5, poi: true }),
      ownCover(2, NsfwLevel.R, { userId: 5, minor: true }),
      noCover(3),
    ]);
    itemCovers([
      itemCover(1, 400, NsfwLevel.PG, { userId: 5 }),
      itemCover(2, 401, NsfwLevel.PG, { userId: 5 }),
      itemCover(3, 300, NsfwLevel.R, { userId: 5, poi: true }),
      itemCover(3, 301, NsfwLevel.R, { userId: 5, minor: true }),
      itemCover(3, 302, NsfwLevel.R, { userId: 5 }),
    ]);
    mockTagIdsFetch.mockResolvedValue({});
    expect(await feed(MATURE_VIEWER)).toEqual([
      { id: 1, own: null, items: [400] },
      { id: 2, own: null, items: [401] },
      { id: 3, own: null, items: [302] },
    ]);
    expect(await feed(MOD_VIEWER)).toEqual([
      { id: 1, own: 101, items: [] },
      { id: 2, own: 102, items: [] },
      { id: 3, own: null, items: [300, 301, 302] },
    ]);
  });

  it('reads a cache miss from the tag table: a tagged image is dropped, an untagged one kept', async () => {
    mockTagIdsFetch.mockResolvedValue({ 301: { imageId: 301, tags: [OTHER_TAG] } });
    mockImageTagRows.mockResolvedValue([{ imageId: 300, tagId: CHILD_TAG, source: 'WD14' }]);
    const result = await feed(MATURE_VIEWER);
    expect(result.find((c) => c.id === 3)).toEqual({ id: 3, own: null, items: [301] });
    expect(result.find((c) => c.id === 1)).toEqual({ id: 1, own: null, items: [400] });
    expect(mockImageTagRows).toHaveBeenCalledWith(expect.anything(), [400, 300]);
  });

  it('reads the tag ids past the local cache', async () => {
    await feed(MATURE_VIEWER);
    expect(mockTagIdsFetch).toHaveBeenCalledWith(expect.any(Array), { bypassLocal: true });
  });
});
