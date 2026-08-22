import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Regression test for the prod 500-floor bug:
//   Invalid `prisma.resourceReview.create()` — Unique constraint failed
//   on (modelVersionId, userId)  (~4/3h)
// Two concurrent creates race; the loser hit the unique constraint and 500ed.
// The create path must resolve idempotently: catch P2002, re-fetch and return
// the already-existing review.

import { Prisma } from '@prisma/client';

const { amIBlockedByUser } = vi.hoisted(() => ({
  amIBlockedByUser: vi.fn(async (..._a: unknown[]): Promise<boolean> => false),
}));

/**
 * The two clients, split — the old fixture aliased them to one object, so every routing claim
 * below was unobservable. Resolved against the entry points this file imports:
 *
 *   dbRead   model.findUnique          block-check.service.ts:283, via getBlockCheckOwnerIds
 *            modelVersion.findFirst    resourceReview.service.ts:267
 *            imageResourceNew.count    resourceReview.service.ts:291
 *            user.findFirst            resourceReview.service.ts:298
 *   dbWrite  resourceReview.findUnique resourceReview.service.ts:327, via storedReviewModelId
 *            resourceReview.create     resourceReview.service.ts:368, :464
 *            resourceReview.update     resourceReview.service.ts:392, :500
 *            resourceReview.findUniqueOrThrow  resourceReview.service.ts:378, :471
 *
 * ⚠️ `resourceReview.findUnique` is ALSO spelled on dbRead, at block-check.service.ts:291 — but
 * only for entityType 'resourceReview', and these paths always ask for 'model'. A whole-module
 * grep finds that line and gets the routing wrong.
 *
 * The unlisted models the service touches (none, on these paths) need no fixture: the canonical
 * mock vivifies any method and answers reads with a plausible empty value.
 */
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

// `getUserResourceReview` is the only caller of this helper and this file does not import it, so
// which client it hands back is off every path here. Replaced rather than spread so the real
// lag logic is not consulted at all.
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
}));
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
  mockDbRead.user.findFirst.mockResolvedValue({ username: 'tester' });
  amIBlockedByUser.mockResolvedValue(false);
  mockDbRead.model.findUnique.mockResolvedValue({ userId: 1 });
  mockDbWrite.resourceReview.findUnique.mockResolvedValue(null);
  // The canonical mock has no default for a write, and callers read what these return —
  // `update`'s result feeds the cache bust, so `undefined` throws in the service rather than
  // in a test. `findUnique` above and `modelVersion.findFirst` / `imageResourceNew.count`
  // already default to null / null / 0, so those stay unstated.
  mockDbWrite.resourceReview.create.mockResolvedValue({});
  mockDbWrite.resourceReview.update.mockResolvedValue({});
  mockDbWrite.resourceReview.findUniqueOrThrow.mockResolvedValue({});
});

describe('createResourceReview — idempotent on P2002 race', () => {
  it('returns the existing review when the unique constraint trips', async () => {
    const existing = { id: 7, modelId: 10, modelVersionId: 20, recommended: true };
    mockDbWrite.resourceReview.create.mockRejectedValueOnce(p2002());
    mockDbWrite.resourceReview.findUniqueOrThrow.mockResolvedValueOnce(existing);

    const result = await createResourceReview({ ...baseInput, userId: 42 });

    expect(result).toBe(existing);
    expect(mockDbWrite.resourceReview.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { modelVersionId_userId: { modelVersionId: 20, userId: 42 } },
      })
    );
  });

  it('rethrows non-P2002 errors', async () => {
    mockDbWrite.resourceReview.create.mockRejectedValueOnce(new Error('boom'));
    await expect(createResourceReview({ ...baseInput, userId: 42 })).rejects.toThrow('boom');
    expect(mockDbWrite.resourceReview.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe('upsertResourceReview (create branch) — idempotent on P2002 race', () => {
  it('returns the existing review when the unique constraint trips', async () => {
    const existing = { id: 7, modelId: 10, modelVersionId: 20, recommended: true };
    mockDbWrite.resourceReview.create.mockRejectedValueOnce(p2002());
    mockDbWrite.resourceReview.findUniqueOrThrow.mockResolvedValueOnce(existing);

    const result = await upsertResourceReview({ ...baseInput, userId: 42 });

    expect(result).toBe(existing);
    expect(mockDbWrite.resourceReview.findUniqueOrThrow).toHaveBeenCalledWith(
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
  // The two clients are distinct now, so the stored-review lookup's choice of client IS pinned:
  // it reads through the WRITER on purpose (see the comment at resourceReview.service.ts:324),
  // and the tests below arm `mockDbWrite.resourceReview.findUnique`. Route that read to the
  // replica and the guard resolves no stored model, so every refusal below stops firing.
  const owners = (byModelId: Record<number, number>) =>
    mockDbRead.model.findUnique.mockImplementation(async (args: unknown) => {
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
    mockDbWrite.resourceReview.findUnique.mockResolvedValue({ modelId: STORED_MODEL });
    blockedBy(STORED_OWNER);

    await expect(
      upsertResourceReview({ ...baseInput, id: 7, modelId: REQUEST_MODEL, userId: AUTHOR })
    ).rejects.toThrow();
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: AUTHOR, targetUserId: STORED_OWNER });
    expect(mockDbWrite.resourceReview.update).not.toHaveBeenCalled();
  });

  it('refuses an upsert edit re-homing onto a model whose owner blocks', async () => {
    mockDbWrite.resourceReview.findUnique.mockResolvedValue({ modelId: STORED_MODEL });
    blockedBy(REQUEST_OWNER);

    await expect(
      upsertResourceReview({ ...baseInput, id: 7, modelId: REQUEST_MODEL, userId: AUTHOR })
    ).rejects.toThrow();
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: AUTHOR, targetUserId: REQUEST_OWNER });
    expect(mockDbWrite.resourceReview.update).not.toHaveBeenCalled();
  });

  it('lets a non-blocked author edit', async () => {
    mockDbWrite.resourceReview.findUnique.mockResolvedValue({ modelId: STORED_MODEL });
    mockDbWrite.resourceReview.update.mockResolvedValueOnce({
      id: 7,
      modelId: 10,
      modelVersionId: 20,
    });

    await upsertResourceReview({ ...baseInput, id: 7, modelId: REQUEST_MODEL, userId: AUTHOR });

    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: AUTHOR, targetUserId: STORED_OWNER });
    expect(mockDbWrite.resourceReview.update).toHaveBeenCalledTimes(1);
  });

  // `resourceReview.create` / `.update` are the procedures the review UI calls; `upsert` is only
  // reached from the edit-review modal. Guarding upsert alone left the ordinary path open.
  it('refuses a create on a model whose owner blocks', async () => {
    blockedBy(REQUEST_OWNER);

    await expect(
      createResourceReview({ ...baseInput, modelId: REQUEST_MODEL, userId: AUTHOR })
    ).rejects.toThrow();
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: AUTHOR, targetUserId: REQUEST_OWNER });
    expect(mockDbWrite.resourceReview.create).not.toHaveBeenCalled();
  });

  it('allows a create when nobody blocks', async () => {
    await createResourceReview({ ...baseInput, modelId: REQUEST_MODEL, userId: AUTHOR });
    expect(mockDbWrite.resourceReview.create).toHaveBeenCalledTimes(1);
  });

  it('refuses an update, resolving the model from the stored review', async () => {
    // `update` carries no modelId at all, so the stored review is the only place the target can
    // come from.
    mockDbWrite.resourceReview.findUnique.mockResolvedValue({ modelId: STORED_MODEL });
    blockedBy(STORED_OWNER);

    await expect(
      updateResourceReview({ id: 7, rating: 5, details: null, userId: AUTHOR })
    ).rejects.toThrow();
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: AUTHOR, targetUserId: STORED_OWNER });
    expect(mockDbWrite.resourceReview.update).not.toHaveBeenCalled();
  });

  it('allows an update when nobody blocks', async () => {
    mockDbWrite.resourceReview.findUnique.mockResolvedValue({ modelId: STORED_MODEL });
    mockDbWrite.resourceReview.update.mockResolvedValueOnce({
      id: 7,
      modelId: 11,
      modelVersionId: 20,
    });

    await updateResourceReview({ id: 7, rating: 5, details: null, userId: AUTHOR });
    expect(mockDbWrite.resourceReview.update).toHaveBeenCalledTimes(1);
  });

  it('exempts moderators on every branch', async () => {
    mockDbWrite.resourceReview.findUnique.mockResolvedValue({ modelId: STORED_MODEL });
    mockDbWrite.resourceReview.update.mockResolvedValue({ id: 7, modelId: 11, modelVersionId: 20 });
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
    // The upsert branch too — it is the one with two model ids to resolve, so it is the one where
    // a dropped `isModerator` would refuse a moderator twice over.
    await upsertResourceReview({
      ...baseInput,
      id: 7,
      modelId: REQUEST_MODEL,
      userId: AUTHOR,
      isModerator: true,
    });
    expect(amIBlockedByUser).not.toHaveBeenCalled();
  });

  // `userId` and `isModerator` are guard inputs, not columns. They reach these functions as part of
  // one object, so a destructure that stops pulling them out sends them into the Prisma payload:
  // on `update` that rewrites the review's author, since the row is scoped by id alone and a
  // moderator may edit someone else's review.
  it('keeps the guard inputs out of the Prisma payload', async () => {
    mockDbWrite.resourceReview.findUnique.mockResolvedValue({ modelId: STORED_MODEL });
    mockDbWrite.resourceReview.update.mockResolvedValue({ id: 7, modelId: 11, modelVersionId: 20 });

    await updateResourceReview({ id: 7, rating: 5, details: null, userId: AUTHOR });
    const updateArgs = mockDbWrite.resourceReview.update.mock.calls[0][0] as { data: object };
    expect(updateArgs.data).not.toHaveProperty('userId');
    expect(updateArgs.data).not.toHaveProperty('isModerator');

    await createResourceReview({
      ...baseInput,
      modelId: REQUEST_MODEL,
      userId: AUTHOR,
      isModerator: true,
    });
    const createArgs = mockDbWrite.resourceReview.create.mock.calls[0][0] as { data: object };
    // `userId` IS a column on create — the review's author. `isModerator` never is.
    expect(createArgs.data).toHaveProperty('userId', AUTHOR);
    expect(createArgs.data).not.toHaveProperty('isModerator');
  });
});
