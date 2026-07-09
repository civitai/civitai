import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression test for the prod 500-floor bug class:
//   Invalid `prisma.modelEngagement.create()` — Unique constraint failed on
//   (userId, modelId)  (~0.26/hr, still 500ing after #2798 fixed the sibling
//   modelVersionEngagement.create).
// "Toggle" engagement procedures read-then-create: two concurrent calls both
// see "absent" and both create; the loser hits the unique constraint (P2002).
// Since the engagement now exists, a toggle is idempotent — the loser must
// resolve to the SAME success value (and run the same side-effects) instead of
// bubbling a 500.

import { Prisma } from '@prisma/client';

const { mockDb, refreshCache } = vi.hoisted(() => ({
  mockDb: {
    modelEngagement: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      update: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      delete: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
    },
    bountyEngagement: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      delete: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
    },
  },
  refreshCache: vi.fn(async () => undefined),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
// HiddenModels.refreshCache is the side-effect the Hide success path runs and
// MUST still run on a P2002. Stub the whole user-preferences module surface that
// user.service reaches for at import time.
vi.mock('~/server/services/user-preferences.service', () => ({
  HiddenModels: { refreshCache },
  HiddenModels3D: { refreshCache: vi.fn(async () => undefined) },
  HiddenUsers: { refreshCache: vi.fn(async () => undefined) },
  HiddenImages: { refreshCache: vi.fn(async () => undefined) },
  HiddenTags: { refreshCache: vi.fn(async () => undefined) },
  BlockedUsers: { refreshCache: vi.fn(async () => undefined), getCached: vi.fn(async () => []) },
  BlockedByUsers: { refreshCache: vi.fn(async () => undefined) },
  ImplicitHiddenImages: { refreshCache: vi.fn(async () => undefined) },
  toggleHidden: vi.fn(async () => ({ added: [], removed: [] })),
}));

import { toggleModelEngagement, toggleUserBountyEngagement } from '~/server/services/user.service';

const p2002 = (target: string[]) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '1',
    meta: { target },
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('toggleModelEngagement — idempotent on P2002 race (the confirmed prod 500)', () => {
  it('Hide: P2002 on create → returns true AND still refreshes the HiddenModels cache', async () => {
    mockDb.modelEngagement.findUnique.mockResolvedValueOnce(null);
    mockDb.modelEngagement.create.mockRejectedValueOnce(p2002(['userId', 'modelId']));

    const result = await toggleModelEngagement({ userId: 42, modelId: 10, type: 'Hide' });

    expect(result).toBe(true);
    // The Hide success path's side-effect must still run on the idempotent path.
    expect(refreshCache).toHaveBeenCalledWith({ userId: 42 });
  });

  it('Notify: P2002 on create → returns true (no cache refresh for non-Hide)', async () => {
    mockDb.modelEngagement.findUnique.mockResolvedValueOnce(null);
    mockDb.modelEngagement.create.mockRejectedValueOnce(p2002(['userId', 'modelId']));

    const result = await toggleModelEngagement({ userId: 42, modelId: 10, type: 'Notify' });

    expect(result).toBe(true);
    expect(refreshCache).not.toHaveBeenCalled();
  });

  it('happy path (no race): creates, returns true, refreshes cache for Hide', async () => {
    mockDb.modelEngagement.findUnique.mockResolvedValueOnce(null);
    mockDb.modelEngagement.create.mockResolvedValueOnce({});

    const result = await toggleModelEngagement({ userId: 42, modelId: 10, type: 'Hide' });

    expect(result).toBe(true);
    expect(mockDb.modelEngagement.create).toHaveBeenCalledTimes(1);
    expect(refreshCache).toHaveBeenCalledWith({ userId: 42 });
  });

  it('rethrows a non-P2002 create error (does not swallow real failures)', async () => {
    mockDb.modelEngagement.findUnique.mockResolvedValueOnce(null);
    mockDb.modelEngagement.create.mockRejectedValueOnce(new Error('connection reset'));

    await expect(
      toggleModelEngagement({ userId: 42, modelId: 10, type: 'Hide' })
    ).rejects.toThrow('connection reset');
    // The side-effect must NOT run when the create genuinely failed.
    expect(refreshCache).not.toHaveBeenCalled();
  });
});

describe('toggleUserBountyEngagement — idempotent on P2002 race (sibling)', () => {
  it('P2002 on create → returns true instead of 500', async () => {
    mockDb.bountyEngagement.findUnique.mockResolvedValueOnce(null);
    mockDb.bountyEngagement.create.mockRejectedValueOnce(
      p2002(['type', 'bountyId', 'userId'])
    );

    const result = await toggleUserBountyEngagement({
      userId: 42,
      bountyId: 5,
      type: 'Favorite' as never,
    });

    expect(result).toBe(true);
  });

  it('rethrows a non-P2002 create error', async () => {
    mockDb.bountyEngagement.findUnique.mockResolvedValueOnce(null);
    mockDb.bountyEngagement.create.mockRejectedValueOnce(new Error('boom'));

    await expect(
      toggleUserBountyEngagement({ userId: 42, bountyId: 5, type: 'Favorite' as never })
    ).rejects.toThrow('boom');
  });
});
