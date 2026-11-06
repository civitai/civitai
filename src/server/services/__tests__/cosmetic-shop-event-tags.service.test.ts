import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';
import type * as HomeBlockCache from '~/server/services/home-block-cache.service';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    sectionFindMany: vi.fn(),
    taggedFindMany: vi.fn(),
    homeBlockCacheBust: vi.fn(),
  },
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  refundTransaction: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  queueImageSearchIndexUpdate: vi.fn(),
  enqueueImageIngestion: vi.fn(),
}));
vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
  dbReadFallbackCounter: { inc: vi.fn() },
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getBlockedPairIds: vi.fn(async () => []),
}));
vi.mock('~/server/services/home-block-cache.service', async (importOriginal) => ({
  ...(await importOriginal<typeof HomeBlockCache>()),
  homeBlockCacheBust: mocks.homeBlockCacheBust,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  getShopItemEventTags,
  getShopSectionsWithItems,
  setShopItemEventTags,
} from '~/server/services/cosmetic-shop.service';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

dbMock.dbRead.cosmeticShopSection.findMany.mockImplementation((...args: unknown[]) =>
  (mocks.sectionFindMany as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbRead.cosmeticShopItem.findMany.mockImplementation((...args: unknown[]) =>
  (mocks.taggedFindMany as (...a: unknown[]) => unknown)(...args)
);

const shopItem = (id: number) => ({
  id,
  title: `item ${id}`,
  createdAt: new Date(2026, 9, id),
  addedById: 2,
  cosmetic: { id: id * 10, createdById: 7, data: {} },
  meta: {},
});
const section = (id: number, meta: Record<string, unknown>, placed: number[] = []) => ({
  id,
  title: `section ${id}`,
  description: null,
  placement: id,
  meta,
  image: null,
  _count: { items: placed.length },
  items: placed.map((itemId) => ({ createdAt: new Date(2026, 0, 1), shopItem: shopItem(itemId) })),
});

/** Serve `rows` to both section reads: the event-tag lookup and the section query. */
function stubSections(rows: ReturnType<typeof section>[]) {
  mocks.sectionFindMany.mockImplementation(async (args: { select?: { items?: unknown } }) =>
    args?.select?.items ? rows : rows.map(({ id, meta }) => ({ id, meta }))
  );
}
const mainSectionsCall = () =>
  mocks.sectionFindMany.mock.calls.find(([args]) => args?.select?.items)![0];
const ids = (s: { items: { shopItem: { id: number } }[] }) => s.items.map((i) => i.shopItem.id);

describe('a shop section with an event tag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.taggedFindMany.mockResolvedValue([]);
  });

  it('takes the published items carrying its tag, after its placed items', async () => {
    stubSections([section(59, { eventTag: 'halloween' }, [1])]);
    mocks.taggedFindMany.mockResolvedValue([shopItem(5), shopItem(4)]);

    const [result] = await getShopSectionsWithItems({ creatorShopEnabled: true });

    expect(ids(result)).toEqual([1, 5, 4]);
  });

  it('asks only for items on sale that carry the tag, under the viewer’s own item rules', async () => {
    stubSections([section(59, { eventTag: 'halloween' })]);

    await getShopSectionsWithItems({ creatorShopEnabled: true });

    const [{ where, take }] = mocks.taggedFindMany.mock.calls[0];
    const viewerRules = mainSectionsCall().select.items.where.shopItem;
    expect(where.AND[0]).toBe(viewerRules);
    expect(where.AND[1]).toEqual({
      eventTags: { has: 'halloween' },
      status: 'Published',
      listed: true,
      archivedAt: null,
      itemDefinitionId: null,
      OR: [{ availableTo: { gte: expect.any(Date) } }, { availableTo: null }],
    });
    expect(take).toBeGreaterThan(0);
  });

  it('still shows a section that has no placed items, filled by its tag alone', async () => {
    stubSections([section(59, { eventTag: 'halloween' })]);
    mocks.taggedFindMany.mockResolvedValue([shopItem(5)]);

    const result = await getShopSectionsWithItems({ creatorShopEnabled: true });

    // The section read must not drop a section for having nothing placed in it.
    expect(mainSectionsCall().where.OR).toContainEqual({ id: { in: [59] } });
    expect(result.map((s) => [s.id, ids(s)])).toEqual([[59, [5]]]);
  });

  it('drops a tag-only section with nothing tagged on sale', async () => {
    stubSections([section(59, { eventTag: 'halloween' })]);

    expect(await getShopSectionsWithItems({ creatorShopEnabled: true })).toEqual([]);
  });

  it('lists an item both placed and tagged once, where it was placed', async () => {
    stubSections([section(59, { eventTag: 'halloween' }, [4, 1])]);
    mocks.taggedFindMany.mockResolvedValue([shopItem(5), shopItem(4)]);

    const [result] = await getShopSectionsWithItems({ creatorShopEnabled: true });

    expect(ids(result)).toEqual([4, 1, 5]);
  });

  // A moderator's own item rules show placed items in any status; the tag must still add only
  // what is on sale, or drafts would reach the storefront preview.
  it('adds only items on sale for a moderator too', async () => {
    stubSections([section(59, { eventTag: 'halloween' })]);

    await getShopSectionsWithItems({ isModerator: true });

    const [{ where }] = mocks.taggedFindMany.mock.calls[0];
    expect(where.AND[1]).toMatchObject({
      status: 'Published',
      listed: true,
      archivedAt: null,
      itemDefinitionId: null,
    });
  });

  // Team hats sell only on their event's page. Tagging one must not put it in the shop.
  it('keeps a tagged event item out of the shop', async () => {
    stubSections([section(59, { eventTag: 'halloween' })]);
    const hat = { ...shopItem(8), cosmetic: { id: 80, createdById: 7, data: { event: 'h26' } } };
    mocks.taggedFindMany.mockResolvedValue([shopItem(5), hat]);

    const [result] = await getShopSectionsWithItems({ creatorShopEnabled: true });

    expect(ids(result)).toEqual([5]);
  });

  it('adds nothing to a section without a tag, and looks nothing up', async () => {
    stubSections([section(3, {}, [1])]);

    const [result] = await getShopSectionsWithItems({ creatorShopEnabled: true });

    expect(ids(result)).toEqual([1]);
    expect(mocks.taggedFindMany).not.toHaveBeenCalled();
  });
});

describe('setting a shop item’s event tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubSections([section(59, { eventTag: 'halloween' }), section(60, { eventTag: 'winter' })]);
  });

  it('saves the tags and clears the homepage entry of each section they enter or leave', async () => {
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValueOnce({ eventTags: ['winter'] });
    dbMock.dbWrite.cosmeticShopItem.update.mockResolvedValueOnce({ eventTags: ['halloween'] });

    expect(await setShopItemEventTags({ shopItemId: 7, eventTags: ['halloween'] })).toEqual([
      'halloween',
    ]);
    expect(dbMock.dbWrite.cosmeticShopItem.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { eventTags: ['halloween'] },
      select: { eventTags: true },
    });
    expect(mocks.homeBlockCacheBust.mock.calls.sort()).toEqual([
      [HomeBlockType.CosmeticShop, 59],
      [HomeBlockType.CosmeticShop, 60],
    ]);
  });

  it('leaves a section with another tag alone', async () => {
    stubSections([
      section(59, { eventTag: 'halloween' }),
      section(60, { eventTag: 'winter' }),
      section(61, { eventTag: 'spring' }),
    ]);
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValueOnce({ eventTags: ['winter'] });
    dbMock.dbWrite.cosmeticShopItem.update.mockResolvedValueOnce({ eventTags: ['halloween'] });

    await setShopItemEventTags({ shopItemId: 7, eventTags: ['halloween'] });

    expect(mocks.homeBlockCacheBust).not.toHaveBeenCalledWith(HomeBlockType.CosmeticShop, 61);
    expect(mocks.homeBlockCacheBust).toHaveBeenCalledTimes(2);
  });

  it('refuses an unknown item with not found, writing nothing', async () => {
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValueOnce(null);

    await expect(
      setShopItemEventTags({ shopItemId: 404, eventTags: ['halloween'] })
    ).rejects.toThrow('No cosmetic shop item with id 404');
    expect(dbMock.dbWrite.cosmeticShopItem.update).not.toHaveBeenCalled();
    dbMock.dbRead.cosmeticShopItem.findUnique.mockResolvedValueOnce(null);
    await expect(getShopItemEventTags({ shopItemId: 404 })).rejects.toThrow(
      'No cosmetic shop item with id 404'
    );
  });

  it('reports a saved change as saved even when the cache bust fails', async () => {
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValueOnce({ eventTags: [] });
    dbMock.dbWrite.cosmeticShopItem.update.mockResolvedValueOnce({ eventTags: ['halloween'] });
    mocks.homeBlockCacheBust.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      setShopItemEventTags({ shopItemId: 7, eventTags: ['halloween'] })
    ).resolves.toEqual(['halloween']);
  });
});
