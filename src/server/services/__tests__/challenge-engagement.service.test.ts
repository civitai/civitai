import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const { mockDb, getExcluded } = vi.hoisted(() => ({
  mockDb: {
    challenge: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
    challengeEngagement: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      delete: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown> => []),
    },
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown> => []),
  },
  getExcluded: vi.fn(async (..._a: unknown[]): Promise<number[]> => []),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
vi.mock('~/server/services/challenge-block.service', () => ({
  getChallengeExcludedUserIds: getExcluded,
}));

import {
  toggleChallengeNotify,
  getChallengeNotifyRecipients,
  getChallengeReminderRecipients,
} from '~/server/services/challenge-engagement.service';

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '1',
    meta: { target: ['type', 'challengeId', 'userId'] },
  });

const openChallenge = { id: 7, status: 'Scheduled', source: 'User', createdById: 99 };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.challenge.findUnique.mockResolvedValue(openChallenge);
});

describe('toggleChallengeNotify', () => {
  it('creates a Notify row and returns true when none exists', async () => {
    mockDb.challengeEngagement.findUnique.mockResolvedValueOnce(null);

    const result = await toggleChallengeNotify({ challengeId: 7, userId: 42 });

    expect(result).toBe(true);
    expect(mockDb.challengeEngagement.create).toHaveBeenCalledTimes(1);
  });

  it('deletes the row and returns false when one exists (blind toggle off)', async () => {
    mockDb.challengeEngagement.findUnique.mockResolvedValueOnce({ type: 'Notify' });

    const result = await toggleChallengeNotify({ challengeId: 7, userId: 42 });

    expect(result).toBe(false);
    expect(mockDb.challengeEngagement.delete).toHaveBeenCalledTimes(1);
  });

  it('explicit setTo:true on an existing row is an idempotent no-op, never a delete', async () => {
    mockDb.challengeEngagement.findUnique.mockResolvedValueOnce({ type: 'Notify' });

    const result = await toggleChallengeNotify({ challengeId: 7, userId: 42, setTo: true });

    expect(result).toBe(true);
    expect(mockDb.challengeEngagement.delete).not.toHaveBeenCalled();
    expect(mockDb.challengeEngagement.create).not.toHaveBeenCalled();
  });

  it('P2002 on create resolves to true instead of bubbling a 500', async () => {
    mockDb.challengeEngagement.findUnique.mockResolvedValueOnce(null);
    mockDb.challengeEngagement.create.mockRejectedValueOnce(p2002());

    const result = await toggleChallengeNotify({ challengeId: 7, userId: 42 });

    expect(result).toBe(true);
  });

  it('rethrows a non-P2002 create error', async () => {
    mockDb.challengeEngagement.findUnique.mockResolvedValueOnce(null);
    mockDb.challengeEngagement.create.mockRejectedValueOnce(new Error('connection reset'));

    await expect(toggleChallengeNotify({ challengeId: 7, userId: 42 })).rejects.toThrow(
      'connection reset'
    );
  });

  it('rejects tracking a challenge that does not exist', async () => {
    mockDb.challenge.findUnique.mockResolvedValueOnce(null);

    await expect(toggleChallengeNotify({ challengeId: 7, userId: 42 })).rejects.toThrow();
    expect(mockDb.challengeEngagement.create).not.toHaveBeenCalled();
  });

  it('rejects tracking a challenge whose creator the viewer has blocked', async () => {
    getExcluded.mockResolvedValueOnce([99]);

    await expect(toggleChallengeNotify({ challengeId: 7, userId: 42 })).rejects.toThrow();
    expect(mockDb.challengeEngagement.create).not.toHaveBeenCalled();
  });

  it('allows untracking a Completed challenge even though tracking it is closed', async () => {
    mockDb.challenge.findUnique.mockResolvedValueOnce({ ...openChallenge, status: 'Completed' });
    mockDb.challengeEngagement.findUnique.mockResolvedValueOnce({ type: 'Notify' });

    const result = await toggleChallengeNotify({ challengeId: 7, userId: 42, setTo: false });

    expect(result).toBe(false);
    expect(mockDb.challengeEngagement.delete).toHaveBeenCalledTimes(1);
  });

  it('rejects newly tracking a Completed challenge', async () => {
    mockDb.challenge.findUnique.mockResolvedValueOnce({ ...openChallenge, status: 'Completed' });
    mockDb.challengeEngagement.findUnique.mockResolvedValueOnce(null);

    await expect(toggleChallengeNotify({ challengeId: 7, userId: 42 })).rejects.toThrow();
  });
});

describe('recipient resolution', () => {
  it('getChallengeNotifyRecipients returns tracker ids only', async () => {
    mockDb.challengeEngagement.findMany.mockResolvedValueOnce([{ userId: 1 }, { userId: 2 }]);

    expect(await getChallengeNotifyRecipients(7)).toEqual([1, 2]);
    expect(mockDb.$queryRaw).not.toHaveBeenCalled();
  });

  it('getChallengeReminderRecipients unions trackers with entrants, de-duplicated', async () => {
    // beforeEach's default challenge has no collectionId, which would short-circuit the entrant query.
    mockDb.challenge.findUnique.mockResolvedValueOnce({ collectionId: 5 });
    mockDb.challengeEngagement.findMany.mockResolvedValueOnce([{ userId: 1 }, { userId: 2 }]);
    mockDb.$queryRaw.mockResolvedValueOnce([{ userId: 2 }, { userId: 3 }]);

    const result = await getChallengeReminderRecipients(7);

    expect([...result].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('getChallengeReminderRecipients skips the entrant query when the challenge has no collection', async () => {
    mockDb.challenge.findUnique.mockResolvedValueOnce({ collectionId: null });
    mockDb.challengeEngagement.findMany.mockResolvedValueOnce([{ userId: 1 }]);

    expect(await getChallengeReminderRecipients(7)).toEqual([1]);
    expect(mockDb.$queryRaw).not.toHaveBeenCalled();
  });
});
