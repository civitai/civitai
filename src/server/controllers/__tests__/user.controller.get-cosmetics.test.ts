import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ImageService from '~/server/services/image.service';
import type * as UserService from '~/server/services/user.service';

const { getUserCosmetics } = vi.hoisted(() => ({ getUserCosmetics: vi.fn() }));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserCosmetics,
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getEntityCoverImage: vi.fn(async () => []),
}));

import { getUserCosmeticsHandler } from '~/server/controllers/user.controller';

type Ctx = Parameters<typeof getUserCosmeticsHandler>[0]['ctx'];

const VIEWER = 990000101;

const row = (id: number, type: string, equippedAt: Date | null = null) => ({
  obtainedAt: new Date('2026-10-01T00:00:00Z'),
  equippedAt,
  equippedToId: null,
  equippedToType: null,
  forId: null,
  forType: null,
  claimKey: 'claimed',
  data: null,
  cosmetic: { id, name: `Cosmetic ${id}`, type, data: {} },
});

beforeEach(() => vi.clearAllMocks());

describe('user.getCosmetics', () => {
  it('groups card glows with the rest', async () => {
    getUserCosmetics.mockResolvedValue({
      cosmetics: [row(1, 'Badge'), row(2, 'CardDecoration')],
    });
    const result = await getUserCosmeticsHandler({
      ctx: { user: { id: VIEWER } } as unknown as Ctx,
    });

    expect(result.cardDecorations.map((c) => c.id)).toEqual([2]);
    expect(result.badges.map((c) => c.id)).toEqual([1]);
  });

  // `inUse` is placement on content; a worn profile item is only ever `equippedAt`.
  it('says which profile item is worn', async () => {
    getUserCosmetics.mockResolvedValue({
      cosmetics: [row(1, 'Badge', new Date('2026-10-02T00:00:00Z')), row(2, 'Badge')],
    });
    const result = await getUserCosmeticsHandler({
      ctx: { user: { id: VIEWER } } as unknown as Ctx,
    });

    expect(result.badges.map((c) => [c.id, c.equipped, c.inUse])).toEqual([
      [1, true, false],
      [2, false, false],
    ]);
  });

  it('marks a creator cosmetic whose own listing was sent back for changes', async () => {
    getUserCosmetics.mockResolvedValue({ cosmetics: [row(1, 'Badge'), row(2, 'Badge')] });
    dbMock.dbRead.cosmeticShopItem.findMany.mockResolvedValue([
      {
        cosmeticId: 1,
        addedById: 5,
        status: 'RequestedChanges',
        rejectionReason: 'Visual quality',
        meta: { displayApproved: false },
        cosmetic: { createdById: 5 },
      },
    ]);
    const result = await getUserCosmeticsHandler({
      ctx: { user: { id: VIEWER } } as unknown as Ctx,
    });

    expect(result.badges.map((c) => [c.id, c.withheld])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  // Worn before withholding unequipped it: it shows to nobody, so the inventory must not say Equipped.
  it('does not report a withheld cosmetic as equipped, though its row is still worn', async () => {
    const worn = new Date('2026-10-02T00:00:00Z');
    getUserCosmetics.mockResolvedValue({
      cosmetics: [row(1, 'ProfileDecoration', worn), row(2, 'ProfileDecoration', worn)],
    });
    dbMock.dbRead.cosmeticShopItem.findMany.mockResolvedValue([
      {
        cosmeticId: 1,
        addedById: 5,
        status: 'RequestedChanges',
        rejectionReason: 'Visual quality',
        meta: { displayApproved: false },
        cosmetic: { createdById: 5 },
      },
      {
        cosmeticId: 2,
        addedById: 5,
        status: 'Published',
        rejectionReason: null,
        meta: {},
        cosmetic: { createdById: 5 },
      },
    ]);
    const result = await getUserCosmeticsHandler({
      ctx: { user: { id: VIEWER } } as unknown as Ctx,
    });

    expect(result.profileDecorations.map((c) => [c.id, c.withheld, c.equipped])).toEqual([
      [1, true, false],
      [2, false, true],
    ]);
  });
});
