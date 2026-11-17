import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.mock('~/server/events/load-events', () => ({ loadEvents: () => [] }));
vi.mock('~/server/flipt/tester-segment', async () => {
  return (await import('~/test-utils/testerFlagFake')).testerFlagModule;
});

const { equipCosmetic, CosmeticEquipRefusedError } = await import('~/server/services/user.service');

const ownershipQuery = expect.objectContaining({
  where: { userId: 9, cosmeticId: { in: [5] } },
});
const owned = (type: string, data: object = { url: 'x.png' }) =>
  [{ obtainedAt: new Date(), cosmetic: { type, data } }] as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('equipCosmetic', () => {
  it('reads ownership from the replica by default, as every other caller does', async () => {
    dbMock.dbRead.userCosmetic.findMany.mockResolvedValue(owned('Badge'));

    await equipCosmetic({ userId: 9, cosmeticId: 5 });

    expect(dbMock.dbRead.userCosmetic.findMany).toHaveBeenCalledWith(ownershipQuery);
    expect(dbMock.dbWrite.userCosmetic.findMany).not.toHaveBeenCalledWith(ownershipQuery);
  });

  it('reads ownership from the primary when asked, so a grant that has not reached the replica still counts', async () => {
    dbMock.dbRead.userCosmetic.findMany.mockResolvedValue([] as never);
    dbMock.dbWrite.userCosmetic.findMany.mockResolvedValue(owned('Badge'));

    await expect(
      equipCosmetic({ userId: 9, cosmeticId: 5, readOwnershipFromPrimary: true })
    ).resolves.toBeUndefined();

    expect(dbMock.dbWrite.userCosmetic.findMany).toHaveBeenCalledWith(ownershipQuery);
    expect(dbMock.dbRead.userCosmetic.findMany).not.toHaveBeenCalledWith(ownershipQuery);
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["You don't have that cosmetic", []],
    ['Stickers cannot be equipped', owned('Sticker')],
    [
      'Event decorations are placed on content, not equipped',
      owned('ProfileDecoration', { event: 'spring' }),
    ],
  ])('refuses with a typed error and the same message: %s', async (message, rows) => {
    dbMock.dbRead.userCosmetic.findMany.mockResolvedValue(rows as never);

    const error = await equipCosmetic({ userId: 9, cosmeticId: 5 }).catch((e) => e);
    expect(error).toBeInstanceOf(CosmeticEquipRefusedError);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(message);
  });
});
