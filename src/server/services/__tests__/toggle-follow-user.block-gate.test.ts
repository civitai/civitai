import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as NotificationService from '~/server/services/notification.service';

const { createNotification } = vi.hoisted(() => ({
  createNotification: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));

import { userFollowsCache } from '~/server/redis/caches';
import { BlockedByUsers } from '~/server/services/user-preferences.service';
import { toggleFollowUser } from '~/server/services/user.service';
import { toggleFollowUserHandler } from '~/server/controllers/user.controller';
import { firstDailyFollowReward } from '~/server/rewards/active/firstDailyFollow.reward';

type Ctx = Parameters<typeof toggleFollowUserHandler>[0]['ctx'];

const userId = 42;
const targetUserId = 99;
const engagement = dbMock.dbWrite.userEngagement;
const REFUSAL = 'You cannot follow a user that has blocked you';

const blockedByTarget = () =>
  vi.spyOn(BlockedByUsers, 'getCached').mockResolvedValue([{ id: targetUserId, username: 't' }]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  engagement.findUnique.mockResolvedValue(null);
  // `mockReset`, not just `clearAllMocks`: a once-value the code under test never consumed
  // would otherwise leak into the next test.
  engagement.findFirst.mockReset().mockResolvedValue(null);
  engagement.create.mockResolvedValue({ user: { username: 'follower' } });
  engagement.deleteMany.mockResolvedValue({ count: 1 });
  engagement.updateMany.mockResolvedValue({ count: 1 });
  vi.spyOn(BlockedByUsers, 'getCached').mockResolvedValue([]);
  vi.spyOn(userFollowsCache, 'update').mockResolvedValue(true);
  vi.spyOn(userFollowsCache, 'refresh').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toggleFollowUser — a user the target blocked cannot follow them', () => {
  it('refuses a new follow, writing no row, notification or follow-cache entry', async () => {
    blockedByTarget();

    await expect(toggleFollowUser({ userId, targetUserId })).rejects.toThrow(REFUSAL);

    expect(engagement.create).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(userFollowsCache.update).not.toHaveBeenCalled();
  });

  it('refuses when the cache misses a block the primary already holds', async () => {
    engagement.findFirst.mockResolvedValue({ userId: targetUserId });

    await expect(toggleFollowUser({ userId, targetUserId })).rejects.toThrow(REFUSAL);

    expect(engagement.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: targetUserId, targetUserId: userId, type: 'Block' },
      })
    );
    expect(engagement.create).not.toHaveBeenCalled();
  });

  it('refuses to turn the follower’s Hide of the target into a Follow', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Hide' });
    blockedByTarget();

    await expect(toggleFollowUser({ userId, targetUserId })).rejects.toThrow(REFUSAL);

    expect(engagement.updateMany).not.toHaveBeenCalled();
  });

  // The gate's read and the block's reverse-Follow delete can interleave so that each
  // misses the other; the follow re-reads after writing so one side always sees it.
  it('unwinds a new follow when a block commits between the check and the write', async () => {
    engagement.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ userId: targetUserId });

    await expect(toggleFollowUser({ userId, targetUserId })).resolves.toBe(false);

    expect(engagement.deleteMany).toHaveBeenCalledWith({
      where: { userId, targetUserId, type: 'Follow' },
    });
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('unwinds a Hide converted to a Follow when a block commits in between', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Hide' });
    engagement.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ userId: targetUserId });

    await expect(toggleFollowUser({ userId, targetUserId })).resolves.toBe(false);

    expect(engagement.deleteMany).toHaveBeenCalledWith({
      where: { userId, targetUserId, type: 'Follow' },
    });
  });

  // Unfollowing must stay open: refusing it would pin a blocked user to a follow
  // they are trying to drop.
  it('still lets a blocked user remove a follow they already hold', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Follow' });
    blockedByTarget();

    await expect(toggleFollowUser({ userId, targetUserId })).resolves.toBe(false);

    expect(engagement.deleteMany).toHaveBeenCalledWith({
      where: { userId, targetUserId, type: 'Follow' },
    });
  });

  it('control: following a user who has not blocked you creates the follow and notifies', async () => {
    await expect(toggleFollowUser({ userId, targetUserId })).resolves.toBe(true);

    expect(engagement.create).toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'followed-by', userId: targetUserId })
    );
  });
});

describe('toggleFollowUserHandler — a refused follow earns nothing', () => {
  const ctx = () =>
    ({
      ip: '127.0.0.1',
      user: { id: userId },
      track: { userEngagement: vi.fn(async () => undefined) },
    } as unknown as Ctx);

  it('applies no reward and tracks nothing when the target blocked the follower', async () => {
    const reward = vi.spyOn(firstDailyFollowReward, 'apply').mockResolvedValue(undefined);
    blockedByTarget();
    const c = ctx();

    await expect(toggleFollowUserHandler({ input: { targetUserId }, ctx: c })).rejects.toThrow(
      REFUSAL
    );

    expect(reward).not.toHaveBeenCalled();
    expect(c.track.userEngagement).not.toHaveBeenCalled();
  });

  it('control: an allowed follow applies the reward', async () => {
    const reward = vi.spyOn(firstDailyFollowReward, 'apply').mockResolvedValue(undefined);

    await expect(toggleFollowUserHandler({ input: { targetUserId }, ctx: ctx() })).resolves.toEqual(
      { following: true }
    );

    expect(reward).toHaveBeenCalled();
  });
});
