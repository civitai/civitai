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

const { amIBlockedByUser } = vi.hoisted(() => ({
  amIBlockedByUser: vi.fn(async (..._a: unknown[]): Promise<boolean> => false),
}));

vi.mock('~/server/services/user.service', () => ({ amIBlockedByUser }));

import {
  getBlockCheckOwnerIds,
  getBlockCheckOwnerIdsForModelComment,
  throwIfBlockedByEntityOwner,
  throwIfBlockedByOwners,
} from '~/server/services/block-check.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDb = dbMock.dbRead;

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

  // Author AND the model owner, matching the `comment` branch below. Author alone left the
  // reaction path (the only `commentOld` consumer) open under a blocker's model.
  it('resolves the legacy comment (commentOld) author and the model owner', async () => {
    const COMMENT_AUTHOR = 55;
    mockDb.comment.findUnique.mockResolvedValue({ userId: COMMENT_AUTHOR, modelId: 3 });
    mockDb.model.findUnique.mockResolvedValue({ userId: OWNER });

    expect(await getBlockCheckOwnerIds({ entityType: 'commentOld', entityId: 1 })).toEqual([
      COMMENT_AUTHOR,
      OWNER,
    ]);
    expect(mockDb.model.findUnique).toHaveBeenCalledWith({
      where: { id: 3 },
      select: { userId: true },
    });
  });

  it('resolves nothing for a legacy comment that no longer exists', async () => {
    mockDb.comment.findUnique.mockResolvedValue(null);
    expect(await getBlockCheckOwnerIds({ entityType: 'commentOld', entityId: 1 })).toEqual([]);
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

  // A reply resolves its root owner from columns selected off `Thread`. Both halves
  // matter: the column has to be SELECTED and the owner branch has to exist. The
  // select assertion is the half a mocked db can't catch by return value alone.
  it('resolves the root owner for a reply in an appListing thread', async () => {
    const PARENT_AUTHOR = 55;
    mockDb.commentV2.findUnique.mockResolvedValueOnce({
      userId: PARENT_AUTHOR,
      thread: { rootThreadId: null, appListingId: 42 },
    });
    mockDb.appListing.findUnique.mockResolvedValueOnce({ userId: OWNER });

    const owners = await getBlockCheckOwnerIds({ entityType: 'comment', entityId: 1 });
    expect(owners).toEqual(expect.arrayContaining([PARENT_AUTHOR, OWNER]));
  });

  it('selects every owner-bearing thread column when resolving a reply root', async () => {
    mockDb.commentV2.findUnique.mockResolvedValueOnce({
      userId: 55,
      thread: { rootThreadId: 999 },
    });
    mockDb.thread.findUnique.mockResolvedValueOnce({ rootThreadId: null });

    await getBlockCheckOwnerIds({ entityType: 'comment', entityId: 1 });

    const select = mockDb.thread.findUnique.mock.calls[0]?.[0]?.select ?? {};
    for (const column of ['challengeId', 'appListingId'])
      expect(select).toHaveProperty(column, true);
  });

  it('resolves the model3d owner', async () => {
    mockDb.model3D.findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'model3d', entityId: 1 })).toEqual([OWNER]);
  });

  it('resolves the model3dReview owner', async () => {
    mockDb.model3DReview.findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'model3dReview', entityId: 1 })).toEqual([
      OWNER,
    ]);
  });

  it('resolves the comicChapter owner via its project', async () => {
    mockDb.comicChapter.findUnique.mockResolvedValueOnce({ project: { userId: OWNER } });
    expect(await getBlockCheckOwnerIds({ entityType: 'comicChapter', entityId: 1 })).toEqual([
      OWNER,
    ]);
  });

  it('resolves the appListing owner by its integer surrogate, not its ULID', async () => {
    mockDb.appListing.findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'appListing', entityId: 42 })).toEqual([
      OWNER,
    ]);
    expect(mockDb.appListing.findUnique).toHaveBeenCalledWith({
      where: { serialId: 42 },
      select: { userId: true },
    });
  });

  it('resolves the challenge creator', async () => {
    mockDb.challenge.findUnique.mockResolvedValueOnce({ createdById: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'challenge', entityId: 1 })).toEqual([OWNER]);
  });

  it('returns [] for a system challenge with no creator', async () => {
    mockDb.challenge.findUnique.mockResolvedValueOnce({ createdById: null });
    expect(await getBlockCheckOwnerIds({ entityType: 'challenge', entityId: 1 })).toEqual([]);
  });

  it('returns [] when the entity does not exist', async () => {
    mockDb.image.findUnique.mockResolvedValueOnce(null);
    expect(await getBlockCheckOwnerIds({ entityType: 'image', entityId: 1 })).toEqual([]);
  });
});

describe('getBlockCheckOwnerIdsForModelComment — legacy model comments', () => {
  const PARENT_AUTHOR = 55;
  const OTHER_OWNER = 200;
  const STORED_MODEL = 1;
  const REQUEST_MODEL = 2;
  const PARENT_ID = 9;

  // Keyed on the id asked for rather than on call order: the resolver reads models and comments
  // through the shared switch, so a `…Once` queue here would be consumed by whichever lookup ran
  // first and the assertion would pass on an empty answer.
  const owners = ({
    models = {},
    comments = {},
  }: {
    models?: Record<number, number>;
    comments?: Record<number, { userId: number; modelId: number }>;
  }) => {
    mockDb.model.findUnique.mockImplementation(async (args: unknown) => {
      const id = (args as { where: { id: number } }).where.id;
      return models[id] ? { userId: models[id] } : null;
    });
    mockDb.comment.findUnique.mockImplementation(async (args: unknown) => {
      const id = (args as { where: { id: number } }).where.id;
      return comments[id] ?? null;
    });
  };

  it('resolves the model owner for a new top-level comment', async () => {
    owners({ models: { [REQUEST_MODEL]: OWNER } });
    expect(await getBlockCheckOwnerIdsForModelComment({ modelId: REQUEST_MODEL })).toEqual([OWNER]);
  });

  it('resolves the parent author as well as the model owner for a reply', async () => {
    owners({
      models: { [REQUEST_MODEL]: OWNER },
      comments: { [PARENT_ID]: { userId: PARENT_AUTHOR, modelId: REQUEST_MODEL } },
    });
    expect(
      await getBlockCheckOwnerIdsForModelComment({ modelId: REQUEST_MODEL, parentId: PARENT_ID })
    ).toEqual([OWNER, PARENT_AUTHOR]);
  });

  it('resolves an edit target from the stored comment, not only the request', async () => {
    // Stored on a model owned by OTHER_OWNER; the request re-homes it onto one owned by OWNER.
    owners({
      models: { [STORED_MODEL]: OTHER_OWNER, [REQUEST_MODEL]: OWNER },
      comments: { 5: { userId: 42, modelId: STORED_MODEL } },
    });

    expect(
      await getBlockCheckOwnerIdsForModelComment({ commentId: 5, modelId: REQUEST_MODEL })
    ).toEqual([OWNER, OTHER_OWNER]);
    expect(mockDb.comment.findUnique).toHaveBeenCalledWith({
      where: { id: 5 },
      select: { modelId: true, parentId: true },
    });
  });

  it('resolves the stored parent author on an edit', async () => {
    owners({
      models: { [STORED_MODEL]: OWNER },
      comments: {
        5: { userId: 42, modelId: STORED_MODEL, parentId: PARENT_ID } as never,
        [PARENT_ID]: { userId: PARENT_AUTHOR, modelId: STORED_MODEL },
      },
    });

    expect(
      await getBlockCheckOwnerIdsForModelComment({ commentId: 5, modelId: STORED_MODEL })
    ).toEqual([OWNER, PARENT_AUTHOR]);
  });

  it('returns [] when nothing resolves', async () => {
    owners({});
    expect(await getBlockCheckOwnerIdsForModelComment({ commentId: 5 })).toEqual([]);
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

  it('rejects a blocked user creating a model3d comment', async () => {
    mockDb.model3D.findUnique.mockResolvedValueOnce({ userId: OWNER });
    amIBlockedByUser.mockResolvedValueOnce(true);
    await expect(
      throwIfBlockedByEntityOwner({ userId: VIEWER, entityType: 'model3d', entityId: 1 })
    ).rejects.toThrow();
  });

  it('rejects a blocked user creating a comicChapter comment', async () => {
    mockDb.comicChapter.findUnique.mockResolvedValueOnce({ project: { userId: OWNER } });
    amIBlockedByUser.mockResolvedValueOnce(true);
    await expect(
      throwIfBlockedByEntityOwner({ userId: VIEWER, entityType: 'comicChapter', entityId: 1 })
    ).rejects.toThrow();
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
