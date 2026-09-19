import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    sectionFindMany: vi.fn(),
    getBlockedPairIds: vi.fn(),
  },
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  refundTransaction: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
  dbReadFallbackCounter: { inc: vi.fn() },
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getBlockedPairIds: mocks.getBlockedPairIds,
}));

import { getShopSectionsWithItems } from '../cosmetic-shop.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

dbMock.dbRead.cosmeticShopSection.findMany.mockImplementation((...args: unknown[]) =>
  (mocks.sectionFindMany as (...a: unknown[]) => unknown)(...args)
);

// The row the selector produces: the item's whole meta column, whatever an
// item happens to carry. What the section list HANDS BACK is the decision this
// file pins — the storefront's cards read a fixed, small set of keys, and this
// path publishes that set rather than the column.
//
// Before deleting this: the response shape of a public endpoint is what it
// guards, not the helper it calls.
const storedMeta = {
  purchases: 12,
  acceptsBlueBuzz: true,
  coverUrl: 'cover.png',
  packMemberCount: 4,
  paidToUserIds: [11, 22],
  creatorId: 33,
  submissionTxId: 'tx-abc',
  submissionFee: 250,
  lastApprovedAmount: 900,
  autoChecks: [{ key: 'transparency', label: 'Transparency', passed: false, detail: 'why' }],
  imageHash: 'a1b2c3',
  history: [{ action: 'reject', userId: 7, at: '2026-01-01T00:00:00.000Z' }],
  imageMeta: { width: 512, height: 512, hasTransparency: false },
  sellableByOthers: true,
  sellerShare: 30,
  rightsAffirmation: { userId: 8, affirmedAt: '2026-01-01', version: 1, statement: 's' },
  takedown: { reason: 'r', moderatorId: 9, at: '2026-01-02' },
};

const sectionRow = {
  id: 1,
  title: 'Badges',
  description: null,
  placement: 1,
  meta: {},
  image: null,
  _count: { items: 1 },
  items: [
    {
      createdAt: new Date(),
      shopItem: {
        id: 42,
        title: 'A badge',
        unitAmount: 100,
        addedById: 999,
        cosmetic: { id: 10, createdById: null },
        meta: storedMeta,
      },
    },
  ],
};

const firstItemMeta = async (args: Parameters<typeof getShopSectionsWithItems>[0] = {}) => {
  const sections = await getShopSectionsWithItems(args);
  return sections[0].items[0].shopItem.meta as Record<string, unknown>;
};

describe('the shop section list publishes only the card fields of an item meta', () => {
  beforeEach(() => {
    mocks.sectionFindMany.mockReset();
    mocks.sectionFindMany.mockResolvedValue([sectionRow]);
    mocks.getBlockedPairIds.mockReset();
    mocks.getBlockedPairIds.mockResolvedValue([]);
  });

  it('returns exactly the display keys to an anonymous viewer', async () => {
    expect(Object.keys(await firstItemMeta()).sort()).toEqual([
      'acceptsBlueBuzz',
      'coverUrl',
      'packMemberCount',
      'purchases',
    ]);
  });

  it('returns the same keys to a moderator — the shape does not branch on the viewer', async () => {
    expect(Object.keys(await firstItemMeta({ isModerator: true })).sort()).toEqual([
      'acceptsBlueBuzz',
      'coverUrl',
      'packMemberCount',
      'purchases',
    ]);
  });

  it('keeps the values the cards render', async () => {
    expect(await firstItemMeta()).toEqual({
      purchases: 12,
      acceptsBlueBuzz: true,
      coverUrl: 'cover.png',
      packMemberCount: 4,
    });
  });

  it('publishes the defaults for an item with no meta at all', async () => {
    mocks.sectionFindMany.mockResolvedValue([
      {
        ...sectionRow,
        items: [
          { ...sectionRow.items[0], shopItem: { ...sectionRow.items[0].shopItem, meta: null } },
        ],
      },
    ]);

    expect(await firstItemMeta()).toEqual({ purchases: 0, acceptsBlueBuzz: false });
  });
});
