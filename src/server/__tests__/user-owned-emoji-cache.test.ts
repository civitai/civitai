import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();

vi.mock('~/server/db/client', () => ({
  dbRead: { userCosmetic: { findMany: (...args: unknown[]) => findMany(...args) } },
  dbWrite: { userCosmetic: { findMany: (...args: unknown[]) => findMany(...args) } },
}));

const { lookupOwnedEmoji: lookupFn } = await import('~/server/redis/caches');

describe('userOwnedEmojiCache', () => {
  beforeEach(() => findMany.mockReset());

  it('treats a purchased-but-never-equipped emoji as owned', async () => {
    // Exactly what purchaseCosmeticShopItem writes: no equippedAt.
    findMany.mockResolvedValue([{ userId: 7, cosmeticId: 12 }]);

    const result = await lookupFn([7]);

    expect(result[7]).toEqual({ userId: 7, cosmeticIds: [12] });
  });

  it('does not filter on equip state', async () => {
    findMany.mockResolvedValue([]);

    await lookupFn([7]);

    const where = findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('equippedAt');
    expect(where).not.toHaveProperty('equippedToId');
    expect(where.cosmetic).toEqual({ type: 'Emoji' });
    expect(where.userId).toEqual({ in: [7] });
  });

  it('groups by user and dedupes ids across claim keys', async () => {
    findMany.mockResolvedValue([
      { userId: 7, cosmeticId: 12 },
      { userId: 7, cosmeticId: 12 },
      { userId: 7, cosmeticId: 13 },
      { userId: 8, cosmeticId: 14 },
    ]);

    const result = await lookupFn([7, 8]);

    expect(result[7].cosmeticIds).toEqual([12, 13]);
    expect(result[8].cosmeticIds).toEqual([14]);
  });

  it('returns nothing for a user with no emoji, rather than throwing', async () => {
    findMany.mockResolvedValue([]);

    expect(await lookupFn([7])).toEqual({});
  });
});
