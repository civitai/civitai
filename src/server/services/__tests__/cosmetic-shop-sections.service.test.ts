import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    sectionFindMany: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { cosmeticShopSection: { findMany: mocks.sectionFindMany } },
  dbWrite: {},
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  refundTransaction: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));
vi.mock('~/server/prom/client', () => ({ dbReadFallbackCounter: { inc: vi.fn() } }));

import { getShopSectionsWithItems } from '../cosmetic-shop.service';

// The regression this file pins: official shop items carry the listing mod's id
// in `addedById`, so viewer gating must key on `cosmetic.createdById` (null =
// official). Filtering on `addedById: null` blanked the shop for every
// non-mod viewer.
const officialItem = {
  createdAt: new Date(),
  shopItem: {
    id: 1,
    title: 'Official badge',
    // Listed by a moderator — addedById is NOT null for official items.
    addedById: 999,
    cosmetic: { id: 10, createdById: null },
    meta: {},
  },
};

const sectionRow = {
  id: 5,
  title: 'Badges',
  description: null,
  placement: 1,
  meta: {},
  image: null,
  _count: { items: 1 },
  items: [officialItem],
};

const capturedShopItemWhere = () =>
  mocks.sectionFindMany.mock.calls[0][0].select.items.where.shopItem;

describe('getShopSectionsWithItems viewer gating', () => {
  beforeEach(() => {
    mocks.sectionFindMany.mockReset();
    mocks.sectionFindMany.mockResolvedValue([sectionRow]);
  });

  it('anonymous / non-mod without the flag: gates on cosmetic.createdById (never addedById) and still returns official items', async () => {
    const sections = await getShopSectionsWithItems({});

    const where = capturedShopItemWhere();
    expect(where.cosmetic).toEqual({ createdById: null });
    expect(where.status).toBe('Published');
    expect(where.archivedAt).toBeNull();
    expect(where.OR).toEqual([{ availableTo: { gte: expect.any(Date) } }, { availableTo: null }]);
    // The regression: official items have addedById set (the listing mod), so
    // this key must never appear in the viewer filter.
    expect(JSON.stringify(where)).not.toContain('addedById');

    expect(sections).toHaveLength(1);
    expect(sections[0].items[0].shopItem.title).toBe('Official badge');
  });

  it('non-mod with the creatorShop flag: creator items are not filtered out, status guard stays', async () => {
    await getShopSectionsWithItems({ creatorShopEnabled: true });

    const where = capturedShopItemWhere();
    expect(where.cosmetic).toEqual({});
    expect(where.status).toBe('Published');
  });

  it('moderator: sees every status and creator items regardless of flag', async () => {
    await getShopSectionsWithItems({ isModerator: true });

    const where = capturedShopItemWhere();
    expect(where.cosmetic).toEqual({});
    expect(where.status).toBeUndefined();
    expect(where.OR).toBeUndefined();
  });

  it('drops sections whose items were entirely filtered out', async () => {
    mocks.sectionFindMany.mockResolvedValue([{ ...sectionRow, items: [] }]);

    const sections = await getShopSectionsWithItems({});
    expect(sections).toHaveLength(0);
  });
});
