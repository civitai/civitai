import { beforeEach, describe, expect, test, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `getStickerAttribution` decides three things a comment reader sees, and each
 * of them is a decision rather than a passthrough:
 *
 * - whether there is a link at all, which is the difference between "buy this"
 *   and a 404 — a disabled shop returns NOT_FOUND to visitors, and a comment can
 *   name any sticker, including one whose creator never opened a shop;
 * - whether a deleted creator's name still shows (it does; the link does not);
 * - that only Sticker cosmetics are answerable at all. That last one is the
 *   reason for a negative control: the procedure is public and takes an array of
 *   ids, so without the type filter it is a name-and-creator lookup over every
 *   cosmetic in the table.
 */

const findMany = dbMock.dbRead.cosmetic.findMany;

const { getStickerAttribution } = await import('~/server/services/cosmetic.service');

const shopOpen = { creatorShop: { enabled: true } };

beforeEach(() => {
  findMany.mockReset();
});

describe('getStickerAttribution', () => {
  test('links to the shop when the creator has one open', async () => {
    findMany.mockResolvedValue([
      {
        id: 1,
        name: 'Garlic Allergy',
        creator: { username: 'neclordx', deletedAt: null, settings: shopOpen },
      },
    ]);

    const [sticker] = await getStickerAttribution({ ids: [1] });

    expect(sticker.creatorName).toBe('neclordx');
    expect(sticker.shopHref).toBe('/user/neclordx/shop');
  });

  test('🔴 names the creator but does NOT link when their shop is disabled', async () => {
    findMany.mockResolvedValue([
      {
        id: 1,
        name: 'Garlic Allergy',
        creator: {
          username: 'neclordx',
          deletedAt: null,
          settings: { creatorShop: { enabled: false } },
        },
      },
    ]);

    const [sticker] = await getStickerAttribution({ ids: [1] });

    expect(sticker.creatorName, 'the maker is still named').toBe('neclordx');
    expect(
      sticker.shopHref,
      'a link to a disabled shop is a 404 — the card would offer to sell something nobody can buy'
    ).toBeNull();
  });

  test('🔴 does NOT link when the creator never opened a shop', async () => {
    findMany.mockResolvedValue([
      {
        id: 1,
        name: 'Staff Sticker',
        creator: { username: 'civitai', deletedAt: null, settings: {} },
      },
    ]);

    const [sticker] = await getStickerAttribution({ ids: [1] });

    expect(sticker.shopHref, 'no shop settings at all is not an open shop').toBeNull();
  });

  test('keeps the name but drops the link for a deleted creator', async () => {
    findMany.mockResolvedValue([
      {
        id: 1,
        name: 'Garlic Allergy',
        creator: { username: 'gone', deletedAt: new Date(), settings: shopOpen },
      },
    ]);

    const [sticker] = await getStickerAttribution({ ids: [1] });

    expect(sticker.name, 'the sticker is still drawn, so its name is still worth showing').toBe(
      'Garlic Allergy'
    );
    expect(sticker.creatorName).toBeNull();
    expect(sticker.shopHref).toBeNull();
  });

  test('handles a sticker with no creator row at all', async () => {
    findMany.mockResolvedValue([{ id: 1, name: 'Orphan', creator: null }]);

    const [sticker] = await getStickerAttribution({ ids: [1] });

    expect(sticker.creatorName).toBeNull();
    expect(sticker.shopHref).toBeNull();
  });

  test('🔴 withholds a BANNED creator, not just a deleted one', async () => {
    findMany.mockResolvedValue([
      {
        id: 1,
        name: 'Garlic Allergy',
        createdById: 7,
        creator: {
          username: 'banned',
          deletedAt: null,
          bannedAt: new Date(),
          settings: shopOpen,
        },
      },
    ]);

    const [sticker] = await getStickerAttribution({ ids: [1] });

    expect(sticker.creatorName, 'a banned creator is not attributed').toBeNull();
    expect(sticker.shopHref).toBeNull();
    expect(sticker.creatorId, 'and nothing keys a creator card on them either').toBeNull();
  });

  test('returns the creator id so the card keys on it rather than a username', async () => {
    findMany.mockResolvedValue([
      {
        id: 1,
        name: 'Garlic Allergy',
        createdById: 7,
        creator: { username: 'neclordx', deletedAt: null, bannedAt: null, settings: shopOpen },
      },
    ]);

    const [sticker] = await getStickerAttribution({ ids: [1] });

    // The viewer's block check needs an id, and every other creator card on the
    // page keys its lookup on id — two keys for one creator misses both caches.
    expect(sticker.creatorId).toBe(7);
  });

  test('🔴 asks only for Sticker cosmetics (negative control on a public, id-taking procedure)', async () => {
    findMany.mockResolvedValue([]);

    await getStickerAttribution({ ids: [1, 2] });

    const where = findMany.mock.calls[0]?.[0]?.where;
    expect(where?.id).toEqual({ in: [1, 2] });
    expect(
      where?.type,
      'without the type filter this is a name-and-creator lookup over every cosmetic'
    ).toBe('Sticker');
  });
});
