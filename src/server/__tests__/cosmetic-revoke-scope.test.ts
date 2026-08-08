import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();
const deleteMany = vi.fn();

vi.mock('~/server/db/client', () => ({
  dbRead: {},
  dbWrite: {
    userCosmetic: {
      findMany: (...args: unknown[]) => findMany(...args),
      deleteMany: (...args: unknown[]) => deleteMany(...args),
    },
  },
}));
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

const { revokeCosmeticsFromUsers } = await import('~/server/services/cosmetic.service');

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
