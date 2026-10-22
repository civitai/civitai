import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks';
import type * as CacheService from '~/server/services/home-block-cache.service';
import type * as CosmeticShopService from '~/server/services/cosmetic-shop.service';
import type * as TesterSegment from '~/server/flipt/tester-segment';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

const { getHomeBlockCached, getShopSectionsWithItems, isFliptPublic } = vi.hoisted(() => ({
  getHomeBlockCached: vi.fn(),
  getShopSectionsWithItems: vi.fn(),
  isFliptPublic: vi.fn(),
}));

vi.mock('~/server/flipt/tester-segment', async (importOriginal) => ({
  ...(await importOriginal<typeof TesterSegment>()),
  isFliptPublic,
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

function stubBlock(cosmeticShopSection: Record<string, unknown>, items = ITEMS) {
  dbMock.dbRead.homeBlock.findUniqueOrThrow.mockResolvedValue({
    id: 40,
    type: HomeBlockType.CosmeticShop,
    userId: -1,
    sourceId: null,
    metadata: { cosmeticShopSection },
  });
  // The shared entry, keyed by section: one object every block of that section is served from.
  const cached = { id: 40, cosmeticShopSection: { id: 9, items: [...items] } };
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

  it('rotates every 3 hours when the block names no rotateHours', async () => {
    stubBlock({ id: 9, random: true });
    const windowStart = 1_000_000 * 3 * HOUR;

    vi.useFakeTimers({ now: windowStart + 1000 });
    const first = ids(await read());
    vi.setSystemTime(windowStart + 3 * HOUR - 1000);
    const sameWindow = ids(await read());
    vi.setSystemTime(windowStart + 3 * HOUR + 1000);

    expect(sameWindow).toEqual(first);
    expect(ids(await read())).not.toEqual(first);
  });

  it('sends three rows of a rotating block, not the whole section', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ shopItem: { id: i + 1 } }));
    stubBlock({ id: 9, random: true }, many);
    expect(ids(await read())).toHaveLength(18);

    stubBlock({ id: 9, random: true, maxItems: 4 }, many);
    expect(ids(await read())).toHaveLength(12);
  });

  it('rotates a copy, leaving the shared entry in section order for blocks that do not rotate', async () => {
    const cached = stubBlock({ id: 9, random: true });

    await read();

    expect(cached.cosmeticShopSection.items).toEqual(ITEMS);
  });

  // The body is shared, so the flag is read as it is for a signed-out viewer. Off must reach the
  // homepage too: it is the switch that pulls creator items, and what a Flipt outage reads as.
  it.each([true, false])(
    'asks the shop service for creator-made items only while creatorShop is public (%s)',
    async (isPublic) => {
      isFliptPublic.mockResolvedValue(isPublic);
      getShopSectionsWithItems.mockResolvedValue([{ id: 9, _count: { items: 1 }, items: [] }]);

      await getHomeBlockData({
        homeBlock: {
          id: 40,
          type: HomeBlockType.CosmeticShop,
          metadata: { cosmeticShopSection: { id: 9 } },
        },
        input: {},
      });

      expect(isFliptPublic).toHaveBeenCalledWith('creator-shop');
      expect(getShopSectionsWithItems).toHaveBeenLastCalledWith({
        sectionId: 9,
        creatorShopEnabled: isPublic,
      });
    }
  );
});
