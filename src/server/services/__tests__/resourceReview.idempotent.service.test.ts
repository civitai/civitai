import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression test for the prod 500-floor bug:
//   Invalid `prisma.resourceReview.create()` — Unique constraint failed
//   on (modelVersionId, userId)  (~4/3h)
// Two concurrent creates race; the loser hit the unique constraint and 500ed.
// The create path must resolve idempotently: catch P2002, re-fetch and return
// the already-existing review.

import { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

// dbWrite for the review write path (resourceReview.findUniqueOrThrow, create), dbRead for the
// user and image reads. `getDbWithoutLag` is mocked wholesale below, so its real lag decision
// never runs; dbRead is the arbitrary side of a choice nothing observes, since the one call it
// feeds - resourceReview.findMany - is never asserted on.
const mockRead = dbMock.dbRead;
const mockWrite = dbMock.dbWrite;

// upsertResourceReview runs a block check that resolves the model owner. Set on both clients
// because the check and the write path reach it from different sides.
mockRead.model.findUnique.mockResolvedValue({ userId: 1 });
mockWrite.model.findUnique.mockResolvedValue({ userId: 1 });
mockWrite.resourceReview.create.mockResolvedValue({});
mockWrite.resourceReview.update.mockResolvedValue({});
mockWrite.resourceReview.findUniqueOrThrow.mockResolvedValue({});

vi.mock('~/server/db/db-lag-helpers', () => ({ getDbWithoutLag: vi.fn(async () => mockRead) }));
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
// createResourceReviewNotification reaches for modelVersion data; stub the
// notification side-channel inputs so it no-ops cleanly.
vi.mock('~/server/services/user-preferences.service', () => ({
  BlockedByUsers: { getCached: vi.fn(async () => []) },
  BlockedUsers: { getCached: vi.fn(async () => []) },
  HiddenUsers: { getCached: vi.fn(async () => []) },
}));
vi.mock('~/server/services/user.service', () => ({
  amIBlockedByUser: vi.fn(async () => false),
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
  mockRead.user.findFirst.mockResolvedValue({ username: 'tester' });
});

describe('createResourceReview — idempotent on P2002 race', () => {
  it('returns the existing review when the unique constraint trips', async () => {
    const existing = { id: 7, modelId: 10, modelVersionId: 20, recommended: true };
    mockWrite.resourceReview.create.mockRejectedValueOnce(p2002());
    mockWrite.resourceReview.findUniqueOrThrow.mockResolvedValueOnce(existing);

    const result = await createResourceReview({ ...baseInput, userId: 42 });

    expect(result).toBe(existing);
    expect(mockWrite.resourceReview.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { modelVersionId_userId: { modelVersionId: 20, userId: 42 } },
      })
    );
  });

  it('rethrows non-P2002 errors', async () => {
    mockWrite.resourceReview.create.mockRejectedValueOnce(new Error('boom'));
    await expect(createResourceReview({ ...baseInput, userId: 42 })).rejects.toThrow('boom');
    expect(mockWrite.resourceReview.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe('upsertResourceReview (create branch) — idempotent on P2002 race', () => {
  it('returns the existing review when the unique constraint trips', async () => {
    const existing = { id: 7, modelId: 10, modelVersionId: 20, recommended: true };
    mockWrite.resourceReview.create.mockRejectedValueOnce(p2002());
    mockWrite.resourceReview.findUniqueOrThrow.mockResolvedValueOnce(existing);

    const result = await upsertResourceReview({ ...baseInput, userId: 42 });

    expect(result).toBe(existing);
    expect(mockWrite.resourceReview.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { modelVersionId_userId: { modelVersionId: 20, userId: 42 } },
      })
    );
  });
});
