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
  updateResourceReview,
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
 * Blocking on the review write paths. `upsertResourceReview` guarded creates only, so a review
 * written before a block stayed editable afterwards — and the two procedures the review UI actually
 * calls, `create` and `update`, had no check at all.
 */
describe('resource review writes — block enforcement', () => {
  const STORED_OWNER = 1;
  const REQUEST_OWNER = 2;
  const AUTHOR = 42;
  const STORED_MODEL = 11;
  const REQUEST_MODEL = 10;

  // Keyed on the model asked for, so an assertion about the stored model cannot be satisfied by a
  // lookup of the requested one.
  const owners = (byModelId: Record<number, number>) =>
    mockDb.model.findUnique.mockImplementation(async (args: unknown) => {
      const id = (args as { where: { id: number } }).where.id;
      return byModelId[id] ? { userId: byModelId[id] } : null;
    });

  const blockedBy = (...userIds: number[]) =>
    amIBlockedByUser.mockImplementation(async (args) =>
      userIds.includes((args as { targetUserId: number }).targetUserId)
    );

  beforeEach(() => {
    owners({ [REQUEST_MODEL]: REQUEST_OWNER, [STORED_MODEL]: STORED_OWNER });
  });

  it('refuses an upsert edit when the review is stored on a model whose owner blocks', async () => {
    // Only the STORED model's owner blocks — this passes if the edit trusts the request's modelId.
    mockDb.resourceReview.findUnique.mockResolvedValue({ modelId: STORED_MODEL });
    blockedBy(STORED_OWNER);

    await expect(
      upsertResourceReview({ ...baseInput, id: 7, modelId: REQUEST_MODEL, userId: AUTHOR })
    ).rejects.toThrow();
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: AUTHOR, targetUserId: STORED_OWNER });
    expect(mockDb.resourceReview.update).not.toHaveBeenCalled();
  });

  it('refuses an upsert edit re-homing onto a model whose owner blocks', async () => {
    mockDb.resourceReview.findUnique.mockResolvedValue({ modelId: STORED_MODEL });
    blockedBy(REQUEST_OWNER);

    await expect(
      upsertResourceReview({ ...baseInput, id: 7, modelId: REQUEST_MODEL, userId: AUTHOR })
    ).rejects.toThrow();
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: AUTHOR, targetUserId: REQUEST_OWNER });
    expect(mockDb.resourceReview.update).not.toHaveBeenCalled();
  });

  it('lets a non-blocked author edit', async () => {
    mockDb.resourceReview.findUnique.mockResolvedValue({ modelId: STORED_MODEL });
    mockDb.resourceReview.update.mockResolvedValueOnce({ id: 7, modelId: 10, modelVersionId: 20 });

    await upsertResourceReview({ ...baseInput, id: 7, modelId: REQUEST_MODEL, userId: AUTHOR });

    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: AUTHOR, targetUserId: STORED_OWNER });
    expect(mockDb.resourceReview.update).toHaveBeenCalledTimes(1);
  });

  // `resourceReview.create` / `.update` are the procedures the review UI calls; `upsert` is only
  // reached from the edit-review modal. Guarding upsert alone left the ordinary path open.
  it('refuses a create on a model whose owner blocks', async () => {
    blockedBy(REQUEST_OWNER);

    await expect(
      createResourceReview({ ...baseInput, modelId: REQUEST_MODEL, userId: AUTHOR })
    ).rejects.toThrow();
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: AUTHOR, targetUserId: REQUEST_OWNER });
    expect(mockDb.resourceReview.create).not.toHaveBeenCalled();
  });

  it('allows a create when nobody blocks', async () => {
    await createResourceReview({ ...baseInput, modelId: REQUEST_MODEL, userId: AUTHOR });
    expect(mockDb.resourceReview.create).toHaveBeenCalledTimes(1);
  });

  it('refuses an update, resolving the model from the stored review', async () => {
    // `update` carries no modelId at all, so the stored review is the only place the target can
    // come from.
    mockDb.resourceReview.findUnique.mockResolvedValue({ modelId: STORED_MODEL });
    blockedBy(STORED_OWNER);

    await expect(
      updateResourceReview({ id: 7, rating: 5, details: null, userId: AUTHOR })
    ).rejects.toThrow();
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: AUTHOR, targetUserId: STORED_OWNER });
    expect(mockDb.resourceReview.update).not.toHaveBeenCalled();
  });

  it('allows an update when nobody blocks', async () => {
    mockDb.resourceReview.findUnique.mockResolvedValue({ modelId: STORED_MODEL });
    mockDb.resourceReview.update.mockResolvedValueOnce({ id: 7, modelId: 11, modelVersionId: 20 });

    await updateResourceReview({ id: 7, rating: 5, details: null, userId: AUTHOR });
    expect(mockDb.resourceReview.update).toHaveBeenCalledTimes(1);
  });

  it('exempts moderators on every branch', async () => {
    mockDb.resourceReview.findUnique.mockResolvedValue({ modelId: STORED_MODEL });
    mockDb.resourceReview.update.mockResolvedValue({ id: 7, modelId: 11, modelVersionId: 20 });
    blockedBy(STORED_OWNER, REQUEST_OWNER);

    await updateResourceReview({
      id: 7,
      rating: 5,
      details: null,
      userId: AUTHOR,
      isModerator: true,
    });
    await createResourceReview({
      ...baseInput,
      modelId: REQUEST_MODEL,
      userId: AUTHOR,
      isModerator: true,
    });
    expect(amIBlockedByUser).not.toHaveBeenCalled();
  });
});
