import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * User-blocking enforcement on write/interaction paths.
 *
 * Blocking used to be enforced read-side only (a blocked viewer 404s on the
 * entity page), so a blocked user could still comment / reply / react / review
 * the creator's content via direct tRPC/API calls. `throwIfBlockedByEntityOwner`
 * closes that gap by resolving the content owner and throwing NotFound (mirroring
 * the read handlers) when the acting user is blocked by that owner.
 */

const { mockDb, amIBlockedByUser } = vi.hoisted(() => ({
  amIBlockedByUser: vi.fn(async (..._a: unknown[]): Promise<boolean> => false),
  mockDb: {
    image: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    post: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    article: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    model: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    resourceReview: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    question: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    answer: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    bounty: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    bountyEntry: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    comment: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    commentV2: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    thread: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
vi.mock('~/server/services/user.service', () => ({ amIBlockedByUser }));

import {
  getBlockCheckOwnerIds,
  throwIfBlockedByEntityOwner,
  throwIfBlockedByOwners,
} from '~/server/services/block-check.service';

const OWNER = 100;
const VIEWER = 7;

beforeEach(() => {
  vi.clearAllMocks();
  amIBlockedByUser.mockResolvedValue(false);
});

describe('getBlockCheckOwnerIds — owner resolution per entity type', () => {
  it('resolves the image owner', async () => {
    mockDb.image.findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'image', entityId: 1 })).toEqual([OWNER]);
  });

  it('resolves the post owner', async () => {
    mockDb.post.findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'post', entityId: 1 })).toEqual([OWNER]);
  });

  it('resolves the model owner', async () => {
    mockDb.model.findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'model', entityId: 1 })).toEqual([OWNER]);
  });

  it('resolves the resourceReview owner (review + resourceReview aliases)', async () => {
    mockDb.resourceReview.findUnique.mockResolvedValue({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'review', entityId: 1 })).toEqual([OWNER]);
    expect(await getBlockCheckOwnerIds({ entityType: 'resourceReview', entityId: 1 })).toEqual([
      OWNER,
    ]);
  });

  it('resolves the legacy comment (commentOld) author', async () => {
    mockDb.comment.findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'commentOld', entityId: 1 })).toEqual([OWNER]);
  });

  it('reply target (comment): resolves BOTH parent author and root content owner', async () => {
    const PARENT_AUTHOR = 55;
    mockDb.commentV2.findUnique.mockResolvedValueOnce({
      userId: PARENT_AUTHOR,
      thread: {
        rootThreadId: 999,
        imageId: null,
        postId: null,
        articleId: null,
        modelId: null,
        reviewId: null,
        bountyId: null,
        bountyEntryId: null,
        questionId: null,
        answerId: null,
      },
    });
    // root thread hangs off an image owned by OWNER
    mockDb.thread.findUnique.mockResolvedValueOnce({
      rootThreadId: null,
      imageId: 42,
      postId: null,
      articleId: null,
      modelId: null,
      reviewId: null,
      bountyId: null,
      bountyEntryId: null,
      questionId: null,
      answerId: null,
    });
    mockDb.image.findUnique.mockResolvedValueOnce({ userId: OWNER });

    const owners = await getBlockCheckOwnerIds({ entityType: 'comment', entityId: 1 });
    expect(owners).toEqual(expect.arrayContaining([PARENT_AUTHOR, OWNER]));
  });

  it('returns [] for unowned/unknown entity types (no false blocks)', async () => {
    expect(await getBlockCheckOwnerIds({ entityType: 'appListing', entityId: 1 })).toEqual([]);
    expect(await getBlockCheckOwnerIds({ entityType: 'challenge', entityId: 1 })).toEqual([]);
  });

  it('returns [] when the entity does not exist', async () => {
    mockDb.image.findUnique.mockResolvedValueOnce(null);
    expect(await getBlockCheckOwnerIds({ entityType: 'image', entityId: 1 })).toEqual([]);
  });
});

describe('throwIfBlockedByEntityOwner — enforcement', () => {
  it('throws NotFound when the acting user is blocked by the content owner', async () => {
    mockDb.image.findUnique.mockResolvedValueOnce({ userId: OWNER });
    amIBlockedByUser.mockResolvedValueOnce(true);
    await expect(
      throwIfBlockedByEntityOwner({ userId: VIEWER, entityType: 'image', entityId: 1 })
    ).rejects.toThrow();
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: VIEWER, targetUserId: OWNER });
  });

  it('does not throw when the acting user is NOT blocked', async () => {
    mockDb.image.findUnique.mockResolvedValueOnce({ userId: OWNER });
    amIBlockedByUser.mockResolvedValue(false);
    await expect(
      throwIfBlockedByEntityOwner({ userId: VIEWER, entityType: 'image', entityId: 1 })
    ).resolves.toBeUndefined();
  });

  it('never blocks the owner acting on their own content (owner === viewer)', async () => {
    mockDb.image.findUnique.mockResolvedValueOnce({ userId: OWNER });
    await throwIfBlockedByEntityOwner({ userId: OWNER, entityType: 'image', entityId: 1 });
    expect(amIBlockedByUser).not.toHaveBeenCalled();
  });

  it('exempts moderators even when blocked', async () => {
    mockDb.image.findUnique.mockResolvedValueOnce({ userId: OWNER });
    amIBlockedByUser.mockResolvedValue(true);
    await expect(
      throwIfBlockedByEntityOwner({
        userId: VIEWER,
        entityType: 'image',
        entityId: 1,
        isModerator: true,
      })
    ).resolves.toBeUndefined();
    expect(amIBlockedByUser).not.toHaveBeenCalled();
  });
});

describe('throwIfBlockedByOwners — reply / legacy-comment helper', () => {
  it('throws if blocked by ANY of the supplied owners (e.g. parent comment author)', async () => {
    amIBlockedByUser.mockImplementation(async ({ targetUserId }: { targetUserId: number }) => {
      return targetUserId === 55; // blocked by the parent comment author only
    });
    await expect(
      throwIfBlockedByOwners({ userId: VIEWER, ownerIds: [OWNER, 55] })
    ).rejects.toThrow();
  });

  it('skips null/undefined owner ids and passes when none block', async () => {
    amIBlockedByUser.mockResolvedValue(false);
    await expect(
      throwIfBlockedByOwners({ userId: VIEWER, ownerIds: [OWNER, null, undefined] })
    ).resolves.toBeUndefined();
  });
});
