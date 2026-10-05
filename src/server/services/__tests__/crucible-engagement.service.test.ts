import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as UserService from '~/server/services/user.service';

const { amIBlockedByUser } = vi.hoisted(() => ({
  amIBlockedByUser: vi.fn<typeof UserService.amIBlockedByUser>(),
}));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser,
}));

const { toggleCrucibleFollow, getFollowedCrucibleIds } = await import(
  '~/server/services/crucible-engagement.service'
);

const read = dbMock.dbRead;
const write = dbMock.dbWrite;

const HOST = 99;
const USER = 42;
const ROW = { type: 'Notify', crucibleId: 7, userId: USER };

const openCrucible = {
  userId: HOST,
  status: 'Active',
  ingestion: 'Scanned',
  image: { ingestion: 'Scanned' },
};

const follow = (opts: { userId?: number; isModerator?: boolean } = {}) =>
  toggleCrucibleFollow({ crucibleId: 7, userId: USER, setTo: true, ...opts });

beforeEach(() => {
  vi.resetAllMocks();
  read.crucible.findUnique.mockResolvedValue(openCrucible);
  read.crucibleEngagement.findMany.mockResolvedValue([]);
  write.crucibleEngagement.findUnique.mockResolvedValue(null);
  write.crucibleEngagement.create.mockResolvedValue({});
  write.crucibleEngagement.deleteMany.mockResolvedValue({ count: 1 });
  amIBlockedByUser.mockResolvedValue(false);
});

describe('toggleCrucibleFollow', () => {
  it('stores a Notify row for the user when following', async () => {
    await expect(follow()).resolves.toBe(true);

    expect(write.crucibleEngagement.create).toHaveBeenCalledWith({ data: ROW });
    expect(write.crucibleEngagement.deleteMany).not.toHaveBeenCalled();
  });

  it('removes exactly that row when unfollowing', async () => {
    await expect(toggleCrucibleFollow({ crucibleId: 7, userId: USER, setTo: false })).resolves.toBe(
      false
    );

    expect(write.crucibleEngagement.deleteMany).toHaveBeenCalledWith({ where: ROW });
    expect(write.crucibleEngagement.create).not.toHaveBeenCalled();
  });

  // The client sends setTo, so a follow made a moment ago may not be on the replica yet; and reading
  // the crucible first would answer differently for a hidden one than for a missing one.
  it('unfollows without reading the follow or the crucible first', async () => {
    await toggleCrucibleFollow({ crucibleId: 7, userId: USER, setTo: false });

    expect(write.crucibleEngagement.findUnique).not.toHaveBeenCalled();
    expect(read.crucible.findUnique).not.toHaveBeenCalled();
  });

  it('without setTo, toggles off a follow that exists on the primary', async () => {
    write.crucibleEngagement.findUnique.mockResolvedValue({ type: 'Notify' });

    await expect(toggleCrucibleFollow({ crucibleId: 7, userId: USER })).resolves.toBe(false);

    expect(write.crucibleEngagement.findUnique).toHaveBeenCalledWith({
      where: { type_crucibleId_userId: ROW },
      select: { type: true },
    });
    expect(write.crucibleEngagement.deleteMany).toHaveBeenCalledWith({ where: ROW });
  });

  it('without setTo, follows when there is no row', async () => {
    await expect(toggleCrucibleFollow({ crucibleId: 7, userId: USER })).resolves.toBe(true);
    expect(write.crucibleEngagement.create).toHaveBeenCalledWith({ data: ROW });
  });

  it('treats an existing row (already following, or a concurrent follow) as success', async () => {
    write.crucibleEngagement.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '1',
      })
    );

    await expect(follow()).resolves.toBe(true);
  });

  it('surfaces any other write failure instead of reporting a follow that was not stored', async () => {
    write.crucibleEngagement.create.mockRejectedValue(new Error('connection reset'));

    await expect(follow()).rejects.toThrow('connection reset');
  });

  it('refuses a crucible that does not exist', async () => {
    read.crucible.findUnique.mockResolvedValue(null);

    await expect(follow()).rejects.toThrow('Crucible not found');
    expect(write.crucibleEngagement.create).not.toHaveBeenCalled();
  });

  it.each([
    ['its text', { ingestion: 'Pending' }],
    ['its cover', { image: { ingestion: 'Pending' } }],
  ])(
    'answers not-found while %s is unscanned, so the id is not confirmed',
    async (_, unscanned) => {
      read.crucible.findUnique.mockResolvedValue({ ...openCrucible, ...unscanned });

      await expect(follow()).rejects.toThrow('Crucible not found');
      expect(write.crucibleEngagement.create).not.toHaveBeenCalled();
    }
  );

  it('lets the host, and a moderator, follow before the scan clears', async () => {
    read.crucible.findUnique.mockResolvedValue({ ...openCrucible, ingestion: 'Pending' });

    await expect(follow({ userId: HOST })).resolves.toBe(true);
    await expect(follow({ isModerator: true })).resolves.toBe(true);
  });

  it('answers not-found when the host has blocked the user', async () => {
    amIBlockedByUser.mockResolvedValue(true);

    await expect(follow()).rejects.toThrow('Crucible not found');
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: USER, targetUserId: HOST });
    expect(write.crucibleEngagement.create).not.toHaveBeenCalled();
  });

  it('does not apply a block to a moderator', async () => {
    amIBlockedByUser.mockResolvedValue(true);

    await expect(follow({ isModerator: true })).resolves.toBe(true);
  });

  it.each(['Completed', 'Cancelled'])('refuses to follow a %s crucible', async (status) => {
    read.crucible.findUnique.mockResolvedValue({ ...openCrucible, status });

    await expect(follow()).rejects.toThrow('already ended');
    expect(write.crucibleEngagement.create).not.toHaveBeenCalled();
  });
});

describe('getFollowedCrucibleIds', () => {
  it("returns the user's follows on crucibles that have not ended", async () => {
    read.crucibleEngagement.findMany.mockResolvedValue([{ crucibleId: 3 }, { crucibleId: 8 }]);

    await expect(getFollowedCrucibleIds(USER)).resolves.toEqual([3, 8]);
    expect(read.crucibleEngagement.findMany).toHaveBeenCalledWith({
      where: {
        userId: USER,
        type: 'Notify',
        crucible: { status: { in: ['Pending', 'Active'] } },
      },
      select: { crucibleId: true },
    });
  });
});
