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
const ROW_KEY = { type_crucibleId_userId: { type: 'Notify', crucibleId: 7, userId: USER } };

const openCrucible = {
  userId: HOST,
  status: 'Active',
  ingestion: 'Scanned',
  image: { ingestion: 'Scanned' },
};

beforeEach(() => {
  vi.resetAllMocks();
  read.crucible.findUnique.mockResolvedValue(openCrucible);
  read.crucibleEngagement.findUnique.mockResolvedValue(null);
  read.crucibleEngagement.findMany.mockResolvedValue([]);
  write.crucibleEngagement.create.mockResolvedValue({});
  write.crucibleEngagement.delete.mockResolvedValue({});
  amIBlockedByUser.mockResolvedValue(false);
});

describe('toggleCrucibleFollow', () => {
  it('stores a Notify row for the user when following', async () => {
    await expect(toggleCrucibleFollow({ crucibleId: 7, userId: USER })).resolves.toBe(true);

    expect(write.crucibleEngagement.create).toHaveBeenCalledWith({
      data: { type: 'Notify', crucibleId: 7, userId: USER },
    });
    expect(write.crucibleEngagement.delete).not.toHaveBeenCalled();
  });

  it('deletes exactly that row when unfollowing', async () => {
    read.crucibleEngagement.findUnique.mockResolvedValue({ type: 'Notify' });

    await expect(toggleCrucibleFollow({ crucibleId: 7, userId: USER })).resolves.toBe(false);

    expect(write.crucibleEngagement.delete).toHaveBeenCalledWith({ where: ROW_KEY });
    expect(write.crucibleEngagement.create).not.toHaveBeenCalled();
  });

  it('setTo: true on an existing follow keeps it rather than toggling it off', async () => {
    read.crucibleEngagement.findUnique.mockResolvedValue({ type: 'Notify' });

    await expect(toggleCrucibleFollow({ crucibleId: 7, userId: USER, setTo: true })).resolves.toBe(
      true
    );

    expect(write.crucibleEngagement.delete).not.toHaveBeenCalled();
    expect(write.crucibleEngagement.create).not.toHaveBeenCalled();
  });

  it('treats a concurrent follow winning the race as success', async () => {
    write.crucibleEngagement.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '1',
      })
    );

    await expect(toggleCrucibleFollow({ crucibleId: 7, userId: USER })).resolves.toBe(true);
  });

  it('refuses a crucible that does not exist', async () => {
    read.crucible.findUnique.mockResolvedValue(null);

    await expect(toggleCrucibleFollow({ crucibleId: 7, userId: USER })).rejects.toThrow(
      'Crucible not found'
    );
    expect(write.crucibleEngagement.create).not.toHaveBeenCalled();
  });

  it('answers not-found for a crucible still hidden by its scan, so the id is not confirmed', async () => {
    read.crucible.findUnique.mockResolvedValue({ ...openCrucible, ingestion: 'Pending' });

    await expect(toggleCrucibleFollow({ crucibleId: 7, userId: USER })).rejects.toThrow(
      'Crucible not found'
    );
    expect(write.crucibleEngagement.create).not.toHaveBeenCalled();
  });

  it('lets the host follow their own crucible before its scan clears', async () => {
    read.crucible.findUnique.mockResolvedValue({ ...openCrucible, ingestion: 'Pending' });

    await expect(toggleCrucibleFollow({ crucibleId: 7, userId: HOST })).resolves.toBe(true);
  });

  it('answers not-found when the host has blocked the user', async () => {
    amIBlockedByUser.mockResolvedValue(true);

    await expect(toggleCrucibleFollow({ crucibleId: 7, userId: USER })).rejects.toThrow(
      'Crucible not found'
    );
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: USER, targetUserId: HOST });
    expect(write.crucibleEngagement.create).not.toHaveBeenCalled();
  });

  it.each(['Completed', 'Cancelled'])('refuses to follow a %s crucible', async (status) => {
    read.crucible.findUnique.mockResolvedValue({ ...openCrucible, status });

    await expect(toggleCrucibleFollow({ crucibleId: 7, userId: USER })).rejects.toThrow(
      'already ended'
    );
    expect(write.crucibleEngagement.create).not.toHaveBeenCalled();
  });

  it('still lets a user unfollow a crucible that has ended', async () => {
    read.crucible.findUnique.mockResolvedValue({ ...openCrucible, status: 'Completed' });
    read.crucibleEngagement.findUnique.mockResolvedValue({ type: 'Notify' });

    await expect(toggleCrucibleFollow({ crucibleId: 7, userId: USER })).resolves.toBe(false);
    expect(write.crucibleEngagement.delete).toHaveBeenCalledWith({ where: ROW_KEY });
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
