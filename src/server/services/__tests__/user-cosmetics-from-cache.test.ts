import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installUserCosmeticCacheFake } from '~/test-utils/userCosmeticCacheFake';

const { getCosmeticsAndProfilePicturesForUsers } = await import('~/server/services/user.service');

/**
 * Hot reads fill a user's `profilePicture` and `cosmetics` from the user caches instead of nesting
 * them in a Prisma select. Every consumer of those reads renders the nested-select shape, so the
 * cache-backed result must be that shape exactly: the same fields, `null` and `[]` for a user with
 * nothing, and only what the user wears.
 */

const WEARER = 7;
const OTHER = 8;
const BARE = 9;

const picture = {
  id: 501,
  name: 'me.png',
  url: 'uuid-1',
  nsfwLevel: 1,
  hash: 'U00000',
  userId: WEARER,
  ingestion: 'Scanned',
  type: 'image',
  width: 512,
  height: 768,
  metadata: { size: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  installUserCosmeticCacheFake({
    userCosmetics: [
      // Worn.
      {
        userId: WEARER,
        cosmeticId: 1,
        data: { lights: 3 },
        equippedAt: new Date(),
        equippedToId: null,
      },
      // Placed on content, not worn.
      { userId: WEARER, cosmeticId: 2, data: null, equippedAt: new Date(), equippedToId: 100 },
      // Held, not equipped.
      { userId: WEARER, cosmeticId: 3, data: null, equippedAt: null, equippedToId: null },
      { userId: OTHER, cosmeticId: 4, data: null, equippedAt: new Date(), equippedToId: null },
    ],
    cosmetics: [
      { id: 1, name: 'Badge', type: 'Badge', source: 'Event', data: { url: 'b.png' }, flags: 2 },
      { id: 2, name: 'Hat', type: 'ContentDecoration', source: 'Event', data: {}, flags: 0 },
      { id: 3, name: 'Frame', type: 'ProfileDecoration', source: 'Purchase', data: {}, flags: 0 },
      { id: 4, name: 'Plate', type: 'NamePlate', source: 'Trophy', data: { c: 'red' }, flags: 0 },
    ],
    profilePictures: [picture],
  });
});

describe('getCosmeticsAndProfilePicturesForUsers', () => {
  it('returns the nested-select shape: the picture, and only the cosmetics the user wears', async () => {
    const forUser = await getCosmeticsAndProfilePicturesForUsers([WEARER, OTHER, BARE]);

    expect(forUser(WEARER)).toStrictEqual({
      profilePicture: picture,
      cosmetics: [
        {
          data: { lights: 3 },
          cosmetic: {
            id: 1,
            data: { url: 'b.png' },
            type: 'Badge',
            source: 'Event',
            name: 'Badge',
          },
        },
      ],
    });
    expect(forUser(OTHER)).toStrictEqual({
      profilePicture: null,
      cosmetics: [
        {
          data: null,
          cosmetic: {
            id: 4,
            data: { c: 'red' },
            type: 'NamePlate',
            source: 'Trophy',
            name: 'Plate',
          },
        },
      ],
    });
    expect(forUser(BARE)).toStrictEqual({ profilePicture: null, cosmetics: [] });
  });

  it('reads all the users in one query per cache, not one per user', async () => {
    await getCosmeticsAndProfilePicturesForUsers([WEARER, OTHER, BARE]);

    expect(dbMock.dbRead.userCosmetic.findMany).toHaveBeenCalledTimes(1);
    const { userId } = dbMock.dbRead.userCosmetic.findMany.mock.calls[0][0].where;
    expect([...userId.in].sort()).toEqual([WEARER, OTHER, BARE]);
    expect(dbMock.dbRead.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
