import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserService from '~/server/services/user.service';

/**
 * A showcase change that only lands in the nightly rebuild is invisible for up to 24h,
 * which is what the report described. The recompute has to be scoped: the full rebuild
 * TRUNCATEs a table the whole site reads.
 */

const { mockUpdateUserById, mockGetUserById, mockUpdateRankForUsers } = vi.hoisted(() => ({
  mockUpdateUserById: vi.fn(),
  mockGetUserById: vi.fn(),
  mockUpdateRankForUsers: vi.fn(),
}));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserById: mockGetUserById,
  updateUserById: mockUpdateUserById,
  updateLeaderboardRankForUsers: mockUpdateRankForUsers,
  equipCosmetic: vi.fn(),
  unequipCosmeticByType: vi.fn(),
  createUserReferral: vi.fn(),
  isUsernamePermitted: vi.fn(async () => true),
}));
vi.mock('~/server/search-index', () => ({
  usersSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/cloudflare/client', () => ({ purgeCache: vi.fn(() => ({ catch: vi.fn() })) }));
vi.mock('~/server/auth/session-invalidation', () => ({ refreshSession: vi.fn() }));

import { updateUserHandler } from '~/server/controllers/user.controller';

const call = (input: Record<string, unknown>) =>
  updateUserHandler({ ctx: { user: { id: 5 } }, input: { id: 5, ...input } } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUserById.mockResolvedValue({ profilePictureId: null });
  mockUpdateUserById.mockResolvedValue({ id: 5, profilePictureId: null });
});

describe('updateUserHandler — leaderboard showcase', () => {
  it('recomputes that user rank as soon as the showcase changes', async () => {
    await call({ leaderboardShowcase: 'flux' });
    expect(mockUpdateRankForUsers).toHaveBeenCalledWith({ userIds: 5 });
  });

  it('recomputes when the showcase is cleared', async () => {
    await call({ leaderboardShowcase: null });
    expect(mockUpdateRankForUsers).toHaveBeenCalledWith({ userIds: 5 });
  });

  // The recompute reads `User.leaderboardShowcase` back out of the database, so it has to
  // run after the write. Ordering is the whole property; both calls happen either way.
  it('recomputes only after the new showcase has been written', async () => {
    await call({ leaderboardShowcase: 'flux' });
    expect(mockUpdateUserById.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpdateRankForUsers.mock.invocationCallOrder[0]
    );
  });

  // Deliberately NOT compared against the stored value: the only cheap read of it is the
  // replica, and an A->B->A save inside the replication window would compare equal and skip
  // the recompute. Recomputing on a cosmetic save is the cheap side of that trade.
  it('recomputes on a cosmetic save that carries the showcase along', async () => {
    await call({ leaderboardShowcase: 'flux', nameplateId: 12 });
    expect(mockUpdateRankForUsers).toHaveBeenCalledWith({ userIds: 5 });
  });

  it('leaves the rank alone when the save omits the showcase', async () => {
    await call({ image: null });
    expect(mockUpdateRankForUsers).not.toHaveBeenCalled();
  });
});
