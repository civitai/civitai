import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks';
import type * as CacheService from '~/server/services/home-block-cache.service';
import type * as CosmeticShopService from '~/server/services/cosmetic-shop.service';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

const { getHomeBlockCached, getShopSectionsWithItems } = vi.hoisted(() => ({
  getHomeBlockCached: vi.fn(),
  getShopSectionsWithItems: vi.fn(),
}));

vi.mock('~/server/services/home-block-cache.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheService>()),
  getHomeBlockCached,
}));
vi.mock('~/server/services/cosmetic-shop.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticShopService>()),
  getShopSectionsWithItems,
}));

const { getHomeBlockById, getHomeBlockData } = await import('~/server/services/home-block.service');

const HOUR = 60 * 60 * 1000;
const ITEMS = Array.from({ length: 12 }, (_, i) => ({ shopItem: { id: i + 1 } }));
type ShopBlock = { cosmeticShopSection?: { items: { shopItem: { id: number } }[] } } | null;
const ids = (block: ShopBlock) => block?.cosmeticShopSection?.items.map((i) => i.shopItem.id);

function stubBlock(cosmeticShopSection: Record<string, unknown>) {
  dbMock.dbRead.homeBlock.findUniqueOrThrow.mockResolvedValue({
    id: 40,
    type: HomeBlockType.CosmeticShop,
    userId: -1,
    sourceId: null,
    metadata: { cosmeticShopSection },
  });
  // The shared entry, keyed by section: one object every block of that section is served from.
  const cached = { id: 40, cosmeticShopSection: { id: 9, items: [...ITEMS] } };
  getHomeBlockCached.mockResolvedValue(cached);
  return cached;
}

const read = () => getHomeBlockById({ id: 40, viewer: undefined as never });

describe('a CosmeticShop home block', () => {
  beforeEach(() => {
    vi.useRealTimers();
    getHomeBlockCached.mockReset();
  });

  it('without `random` is served exactly as the cache holds it', async () => {
    const cached = stubBlock({ id: 9, maxItems: 6 });

    expect(await read()).toBe(cached);
  });

  it('with `random` shows every visitor in a window the same order, and a new one next window', async () => {
    stubBlock({ id: 9, random: true, rotateHours: 3 });
    const windowStart = 1_000_000 * 3 * HOUR;

    vi.useFakeTimers({ now: windowStart + 1000 });
    const first = ids(await read());
    vi.setSystemTime(windowStart + 3 * HOUR - 1000);
    const sameWindow = ids(await read());
    vi.setSystemTime(windowStart + 3 * HOUR + 1000);
    const nextWindow = ids(await read());

    expect(sameWindow).toEqual(first);
    expect([...(first ?? [])].sort((a, b) => a - b)).toEqual(ITEMS.map((i) => i.shopItem.id));
    expect(first).not.toEqual(ITEMS.map((i) => i.shopItem.id));
    expect(nextWindow).not.toEqual(first);
  });

  it('rotates a copy, leaving the shared entry in section order for blocks that do not rotate', async () => {
    const cached = stubBlock({ id: 9, random: true });

    await read();

    expect(cached.cosmeticShopSection.items).toEqual(ITEMS);
  });

  it("asks the shop service for creator-made items, since the body can't resolve a viewer's flag", async () => {
    getShopSectionsWithItems.mockResolvedValue([{ id: 9, _count: { items: 1 }, items: [] }]);

    await getHomeBlockData({
      homeBlock: {
        id: 40,
        type: HomeBlockType.CosmeticShop,
        metadata: { cosmeticShopSection: { id: 9 } },
      },
      input: {},
    });

    expect(getShopSectionsWithItems).toHaveBeenCalledWith({
      sectionId: 9,
      creatorShopEnabled: true,
    });
  });
});
