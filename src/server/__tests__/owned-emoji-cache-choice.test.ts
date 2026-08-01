import { beforeEach, describe, expect, it, vi } from 'vitest';

// Pins WHICH cache the send-time ownership gate reads. userCosmeticCache holds
// only EQUIPPED cosmetics; emoji are owned and never equipped, so reading it
// makes every purchased emoji unsendable. That shipped once — this is the guard.
const userOwnedEmojiFetch = vi.fn();
const userCosmeticFetch = vi.fn();
const cosmeticFetch = vi.fn();

vi.mock('~/server/redis/caches', () => ({
  userOwnedEmojiCache: { fetch: userOwnedEmojiFetch, refresh: vi.fn() },
  userCosmeticCache: { fetch: userCosmeticFetch, refresh: vi.fn() },
  cosmeticCache: { fetch: cosmeticFetch },
  cosmeticEntityCaches: {},
  refreshOwnedEmojiCache: vi.fn(),
}));

const { getOwnedEmojiCosmetics } = await import('~/server/services/cosmetic.service');

describe('getOwnedEmojiCosmetics', () => {
  beforeEach(() => {
    userOwnedEmojiFetch.mockReset().mockResolvedValue({ 7: { userId: 7, cosmeticIds: [12] } });
    userCosmeticFetch.mockReset().mockResolvedValue({});
    cosmeticFetch.mockReset().mockResolvedValue({
      12: { id: 12, name: 'Party Cat', type: 'Emoji', data: { slug: 'party_cat', url: 'abc' } },
    });
  });

  it('reads the owned-emoji cache, never the equipped-cosmetics cache', async () => {
    await getOwnedEmojiCosmetics(7);

    expect(userOwnedEmojiFetch).toHaveBeenCalledWith([7]);
    expect(userCosmeticFetch).not.toHaveBeenCalled();
  });

  it('resolves the owned ids through the cosmetic cache', async () => {
    expect(await getOwnedEmojiCosmetics(7)).toEqual([
      { id: 12, name: 'Party Cat', slug: 'party_cat', url: 'abc', animated: undefined },
    ]);
    expect(cosmeticFetch).toHaveBeenCalledWith([12]);
  });

  it('short-circuits without hitting the cosmetic cache when nothing is owned', async () => {
    userOwnedEmojiFetch.mockResolvedValue({});

    expect(await getOwnedEmojiCosmetics(7)).toEqual([]);
    expect(cosmeticFetch).not.toHaveBeenCalled();
  });
});
