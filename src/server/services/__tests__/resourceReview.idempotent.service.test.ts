import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression test for the prod 500-floor bug:
//   Invalid `prisma.resourceReview.create()` — Unique constraint failed
//   on (modelVersionId, userId)  (~4/3h)
// Two concurrent creates race; the loser hit the unique constraint and 500ed.
// The create path must resolve idempotently: catch P2002, re-fetch and return
// the already-existing review.

import { Prisma } from '@prisma/client';

const { mockDb, amIBlockedByUser } = vi.hoisted(() => ({
  amIBlockedByUser: vi.fn(async (..._a: unknown[]): Promise<boolean> => false),
  mockDb: {
    user: { findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    // createResourceReviewNotification (fired best-effort after the create
    // resolves) reads modelVersion; a null result makes it log+return cleanly.
    modelVersion: { findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    // upsertResourceReview now runs a block check that resolves the model owner.
    model: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ userId: 1 })) },
    imageResourceNew: { count: vi.fn(async (..._a: unknown[]): Promise<number> => 0) },
    resourceReview: {
      // The edit branch resolves the review's stored model before the block check.
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      update: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      findUniqueOrThrow: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
vi.mock('~/server/db/db-lag-helpers', () => ({ getDbWithoutLag: vi.fn(async () => mockDb) }));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/resourceReview.cache', () => ({
  bustRatingTotalsCache: vi.fn(async () => undefined),
  bustRatingTotalsForRows: vi.fn(async () => undefined),
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn(async () => undefined) }));
// createResourceReviewNotification reaches for modelVersion data; stub the
// notification side-channel inputs so it no-ops cleanly.
vi.mock('~/server/services/user-preferences.service', () => ({
  BlockedByUsers: { getCached: vi.fn(async () => []) },
  BlockedUsers: { getCached: vi.fn(async () => []) },
  HiddenUsers: { getCached: vi.fn(async () => []) },
}));
vi.mock('~/server/services/user.service', () => ({
  amIBlockedByUser,
  getBasicDataForUsers: vi.fn(async () => new Map()),
  getCosmeticsForUsers: vi.fn(async () => ({})),
  getProfilePicturesForUsers: vi.fn(async () => ({})),
}));

import {
  createResourceReview,
  upsertResourceReview,
} from '~/server/services/resourceReview.service';

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '1',
    meta: { target: ['modelVersionId', 'userId'] },
  });

const baseInput = {
  modelId: 10,
  modelVersionId: 20,
  rating: 5,
  recommended: true,
  details: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.user.findFirst.mockResolvedValue({ username: 'tester' });
  amIBlockedByUser.mockResolvedValue(false);
  mockDb.model.findUnique.mockResolvedValue({ userId: 1 });
  mockDb.resourceReview.findUnique.mockResolvedValue(null);
});

describe('createResourceReview — idempotent on P2002 race', () => {
  it('returns the existing review when the unique constraint trips', async () => {
    const existing = { id: 7, modelId: 10, modelVersionId: 20, recommended: true };
    mockDb.resourceReview.create.mockRejectedValueOnce(p2002());
    mockDb.resourceReview.findUniqueOrThrow.mockResolvedValueOnce(existing);

    const result = await createResourceReview({ ...baseInput, userId: 42 });

    expect(result).toBe(existing);
    expect(mockDb.resourceReview.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { modelVersionId_userId: { modelVersionId: 20, userId: 42 } },
      })
    );
  });

  it('rethrows non-P2002 errors', async () => {
    mockDb.resourceReview.create.mockRejectedValueOnce(new Error('boom'));
    await expect(createResourceReview({ ...baseInput, userId: 42 })).rejects.toThrow('boom');
    expect(mockDb.resourceReview.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe('upsertResourceReview (create branch) — idempotent on P2002 race', () => {
  it('returns the existing review when the unique constraint trips', async () => {
    const existing = { id: 7, modelId: 10, modelVersionId: 20, recommended: true };
    mockDb.resourceReview.create.mockRejectedValueOnce(p2002());
    mockDb.resourceReview.findUniqueOrThrow.mockResolvedValueOnce(existing);

    const result = await upsertResourceReview({ ...baseInput, userId: 42 });

    expect(result).toBe(existing);
    expect(mockDb.resourceReview.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { modelVersionId_userId: { modelVersionId: 20, userId: 42 } },
      })
    );
  });
});

/**
 * A review written before a block stayed editable afterwards: the guard ran on create only, and an
 * edit writes `modelId` through from the request while being scoped by review id — so it could also
 * be re-homed onto a model whose owner had blocked the author.
 */
describe('upsertResourceReview (edit branch) — block enforcement', () => {
  const OWNER = 1;
  const OTHER_OWNER = 2;
  const AUTHOR = 42;

  it('throws and never updates when the author is blocked by the stored model owner', async () => {
    mockDb.resourceReview.findUnique.mockResolvedValue({ modelId: 10 });
    amIBlockedByUser.mockResolvedValue(true);

    await expect(upsertResourceReview({ ...baseInput, id: 7, userId: AUTHOR })).rejects.toThrow();
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: AUTHOR, targetUserId: OWNER });
    expect(mockDb.resourceReview.update).not.toHaveBeenCalled();
  });

  it('updates when the author is not blocked', async () => {
    mockDb.resourceReview.findUnique.mockResolvedValue({ modelId: 10 });
    mockDb.resourceReview.update.mockResolvedValueOnce({ id: 7, modelId: 10, modelVersionId: 20 });

    await upsertResourceReview({ ...baseInput, id: 7, userId: AUTHOR });

    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: AUTHOR, targetUserId: OWNER });
    expect(mockDb.resourceReview.update).toHaveBeenCalledTimes(1);
  });

  it('checks the model the edit points at, not only the one it is stored on', async () => {
    // Stored on model 11 (owner 1, no block); the request re-homes it onto model 10 (owner 2).
    mockDb.resourceReview.findUnique.mockResolvedValue({ modelId: 11 });
    mockDb.model.findUnique.mockImplementation(async (args: unknown) => ({
      userId: (args as { where: { id: number } }).where.id === 10 ? OTHER_OWNER : OWNER,
    }));
    amIBlockedByUser.mockImplementation(
      async (args) => (args as { targetUserId: number }).targetUserId === OTHER_OWNER
    );

    await expect(upsertResourceReview({ ...baseInput, id: 7, userId: AUTHOR })).rejects.toThrow();
    expect(mockDb.resourceReview.update).not.toHaveBeenCalled();
  });
});
