import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const findMany = dbMock.dbWrite.userCosmetic.findMany;
const deleteMany = dbMock.dbWrite.userCosmetic.deleteMany;

vi.mock('~/server/redis/caches', () => ({
  userCosmeticCache: { refresh: vi.fn() },
  cosmeticEntityCaches: {},
  refreshOwnedStickerCache: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({
  modelsSearchIndex: { queueUpdate: vi.fn() },
  articlesSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/image.service', () => ({ queueImageSearchIndexUpdate: vi.fn() }));

const { revokeCosmeticsFromUsers, unassignCosmetic } = await import(
  '~/server/services/cosmetic.service'
);

const USERS = [11, 12];
const COSMETICS = [301, 302];

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  deleteMany.mockResolvedValue({ count: 3 });
});

describe('revokeCosmeticsFromUsers claim scoping', () => {
  it('deletes everything when no claim scope is given', async () => {
    await revokeCosmeticsFromUsers({ userIds: USERS, cosmeticIds: COSMETICS });
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany.mock.calls[0][0].where.claimKey).toBeUndefined();
  });

  it('scopes the delete to the given claim keys', async () => {
    await revokeCosmeticsFromUsers({
      userIds: USERS,
      cosmeticIds: COSMETICS,
      claimKeys: ['pack-tx-a'],
    });
    expect(deleteMany.mock.calls[0][0].where.claimKey).toEqual({ in: ['pack-tx-a'] });
  });

  // The empty array is the dangerous case, not the absent one: a pack that never
  // sold produces one, and treating it as "no scope" turns a targeted revoke
  // into stripping every holder of every member cosmetic.
  it('revokes NOTHING when the claim scope is empty', async () => {
    const { revoked } = await revokeCosmeticsFromUsers({
      userIds: USERS,
      cosmeticIds: COSMETICS,
      claimKeys: [],
    });
    expect(revoked).toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
});

// A revoked cosmetic the user was wearing still shows on their search document (search results,
// user pickers) until the users index re-pulls them, which it does only for queued ids.
describe('revoking or unassigning a worn cosmetic queues the wearer', () => {
  const WEARER = 11;
  const wearersOnly = (async (args: { where: { equippedToId?: unknown } }) =>
    args.where.equippedToId === null ? [{ userId: WEARER }] : []) as never;

  it('revokeCosmeticsFromUsers queues the users who were wearing it, and only them', async () => {
    findMany.mockImplementation(wearersOnly);
    const { usersSearchIndex } = await import('~/server/search-index/users.search-index');
    const queue = vi.spyOn(usersSearchIndex, 'queueUpdate').mockResolvedValue();
    onTestFinished(() => queue.mockRestore());

    await revokeCosmeticsFromUsers({ userIds: USERS, cosmeticIds: COSMETICS });

    expect(queue.mock.calls.flatMap(([items]) => items.map((x) => x.id))).toEqual([WEARER]);
  });

  it('unassignCosmetic queues the users who were wearing it, and only them', async () => {
    findMany.mockImplementation(wearersOnly);
    const { usersSearchIndex } = await import('~/server/search-index/users.search-index');
    const queue = vi.spyOn(usersSearchIndex, 'queueUpdate').mockResolvedValue();
    onTestFinished(() => queue.mockRestore());

    await unassignCosmetic({ cosmeticId: COSMETICS[0], userIds: USERS });

    expect(queue.mock.calls.flatMap(([items]) => items.map((x) => x.id))).toEqual([WEARER]);
  });
});
