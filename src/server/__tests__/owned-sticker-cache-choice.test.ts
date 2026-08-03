import { beforeEach, describe, expect, it, vi } from 'vitest';

// Pins WHICH cache the send-time ownership gate reads. userCosmeticCache holds
// only EQUIPPED cosmetics; sticker are owned and never equipped, so reading it
// makes every purchased sticker unsendable. That shipped once — this is the guard.
const userOwnedStickerFetch = vi.fn();
const userCosmeticFetch = vi.fn();
const cosmeticFetch = vi.fn();

vi.mock('~/server/redis/caches', () => ({
  userOwnedStickerCache: { fetch: userOwnedStickerFetch, refresh: vi.fn() },
  userCosmeticCache: { fetch: userCosmeticFetch, refresh: vi.fn() },
  cosmeticCache: { fetch: cosmeticFetch },
  cosmeticEntityCaches: {},
  refreshOwnedStickerCache: vi.fn(),
}));

const { getOwnedStickerCosmetics } = await import('~/server/services/cosmetic.service');

describe('getOwnedStickerCosmetics', () => {
  beforeEach(() => {
    userOwnedStickerFetch.mockReset().mockResolvedValue({ 7: { userId: 7, cosmeticIds: [12] } });
    userCosmeticFetch.mockReset().mockResolvedValue({});
    cosmeticFetch.mockReset().mockResolvedValue({
      12: { id: 12, name: 'Party Cat', type: 'Sticker', data: { slug: 'party_cat', url: 'abc' } },
    });
  });

  it('reads the owned-sticker cache, never the equipped-cosmetics cache', async () => {
    await getOwnedStickerCosmetics(7);

    expect(userOwnedStickerFetch).toHaveBeenCalledWith([7]);
    expect(userCosmeticFetch).not.toHaveBeenCalled();
  });

  it('resolves the owned ids through the cosmetic cache', async () => {
    expect(await getOwnedStickerCosmetics(7)).toEqual([
      { id: 12, name: 'Party Cat', slug: 'party_cat', url: 'abc', animated: undefined },
    ]);
    expect(cosmeticFetch).toHaveBeenCalledWith([12]);
  });

  it('short-circuits without hitting the cosmetic cache when nothing is owned', async () => {
    userOwnedStickerFetch.mockResolvedValue({});

    expect(await getOwnedStickerCosmetics(7)).toEqual([]);
    expect(cosmeticFetch).not.toHaveBeenCalled();
  });
});
